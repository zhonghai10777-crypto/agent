import { copyFile, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  stubNextOpenDialog,
} from "../helpers/electron-app";

const fixtures = resolve(__dirname, "..", "fixtures", "documents");

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
