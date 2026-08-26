import { copyFile, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "@playwright/test";
import type { SessionRef } from "@pi-gui/session-driver";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  runReadDocumentTool,
  stubNextOpenDialog,
} from "../helpers/electron-app";

const fixtures = resolve(__dirname, "..", "fixtures", "documents");

async function selectedSessionRef(window: Parameters<typeof getDesktopState>[0]): Promise<SessionRef> {
  const state = await getDesktopState(window);
  if (!state.selectedWorkspaceId || !state.selectedSessionId) {
    throw new Error("Expected a selected session");
  }
  return { workspaceId: state.selectedWorkspaceId, sessionId: state.selectedSessionId };
}

test("reports what it parsed out of an attached document, and says when it could not", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("attach-document-workspace");
  const documentDir = await mkdtemp(join(tmpdir(), "pi-gui-documents-"));

  // Copied out of the fixtures dir so the attachment sits outside the
  // workspace, which is where a downloaded standard actually lives.
  const standardPath = join(documentDir, "运行规程.pdf");
  const scannedPath = join(documentDir, "扫描件.pdf");
  await copyFile(join(fixtures, "standard-zh.pdf"), standardPath);
  await copyFile(join(fixtures, "scanned-zh.pdf"), scannedPath);

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Document attach session");

    await stubNextOpenDialog(harness, [standardPath]);
    await window.getByRole("button", { name: "Attach files" }).click();

    const chip = window.locator(".composer-attachment").filter({ hasText: "运行规程.pdf" });
    await expect(chip).toBeVisible();
    await expect(chip.locator(".composer-attachment__status")).toHaveText("2 page(s) read");
    await expect(chip.locator(".composer-attachment__status--failed")).toHaveCount(0);

    // The decisive case: an image-only PDF has to announce itself before the
    // user asks a question the model cannot answer from it.
    await stubNextOpenDialog(harness, [scannedPath]);
    await window.getByRole("button", { name: "Attach files" }).click();

    const scanned = window.locator(".composer-attachment").filter({ hasText: "扫描件.pdf" });
    await expect(scanned.locator(".composer-attachment__status--failed")).toContainText("no text layer");
  } finally {
    await harness.close();
  }
});

test("read_document reaches the attaching thread's documents and no other thread's", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("document-scope-workspace");
  const documentDir = await mkdtemp(join(tmpdir(), "pi-gui-documents-"));

  const standardPath = join(documentDir, "运行规程.pdf");
  await copyFile(join(fixtures, "standard-zh.pdf"), standardPath);

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();

    await createNamedThread(window, "Thread with the standard");
    const withDocument = await selectedSessionRef(window);
    await stubNextOpenDialog(harness, [standardPath]);
    await window.getByRole("button", { name: "Attach files" }).click();
    await expect(window.locator(".composer-attachment").filter({ hasText: "运行规程.pdf" })).toBeVisible();

    const allowed = await runReadDocumentTool(harness, withDocument, { path: standardPath });
    expect(allowed.content[0]?.text).toContain("第 3.2 条");

    // A second thread in the same workspace was never given this file. Reading
    // it there would leak one conversation's attachments into another.
    await createNamedThread(window, "Thread without the standard");
    const withoutDocument = await selectedSessionRef(window);
    expect(withoutDocument.sessionId).not.toBe(withDocument.sessionId);

    const denied = await runReadDocumentTool(harness, withoutDocument, { path: standardPath });
    expect(denied.content[0]?.text).toContain("not attached to this conversation");
    expect(denied.content[0]?.text).not.toContain("第 3.2 条");
  } finally {
    await harness.close();
  }
});
