import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import type { SessionRef } from "@pi-gui/session-driver";
import {
  createNamedThread,
  desktopShortcut,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  runLibraryRuntimeTool,
  runOfficeRuntimeTool,
  runReadDocumentTool,
} from "../helpers/electron-app";

const fixtures = resolve(__dirname, "..", "fixtures", "documents");

test("local library is searchable and readable while remaining outside the Office write scope", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir("library-runtime-");
  const workspacePath = await makeWorkspace("library-runtime-workspace");
  const libraryRoot = testInfo.outputPath("reference-library");
  await mkdir(libraryRoot, { recursive: true });

  const pdfPath = join(libraryRoot, "锅炉运行规程.pdf");
  const wordPath = join(libraryRoot, "设备规程.docx");
  const scannedPath = join(libraryRoot, "扫描规程.pdf");
  await copyFile(join(fixtures, "standard-zh.pdf"), pdfPath);
  await copyFile(join(fixtures, "standard-zh.docx"), wordPath);
  await copyFile(join(fixtures, "scanned-zh.pdf"), scannedPath);
  await writeFile(
    join(userDataDir, "library.json"),
    `${JSON.stringify({ enabled: true, roots: [libraryRoot] }, null, 2)}\n`,
    "utf8",
  );

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
    envOverrides: { PI_APP_DEFAULT_RUNTIME_MODE: "light" },
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Library runtime session");
    const sessionRef = await selectedSessionRef(window);

    await expect
      .poll(() => window.evaluate(() => window.piApp?.getLibraryIndexStatus()), { timeout: 60_000 })
      .toMatchObject({ state: "ready", documents: 2 });

    await window.keyboard.press(desktopShortcut(","));
    await window.getByRole("button", { name: "Local library", exact: true }).click();
    await expect(window.getByText(/Prepared 2 documents across/)).toBeVisible();
    await expect(window.getByText("扫描规程.pdf", { exact: true })).toBeVisible();
    await expect(window.getByText(/no text layer/)).toBeVisible();

    const search = await runLibraryRuntimeTool(harness, "library_search", {
      query: "额定负荷 效率",
    });
    expect(search.content[0]?.text).toContain("《锅炉运行规程》 第 1 页");
    expect(search.content[0]?.text).toContain(`Path: ${pdfPath}`);

    const read = await runReadDocumentTool(harness, sessionRef, { path: pdfPath, part: 1 });
    expect(read.content[0]?.text).toContain("第 3.2 条");

    const deniedWrite = await runOfficeRuntimeTool(harness, sessionRef, "word_replace", {
      sourcePath: wordPath,
      search: "原始内容",
      replacement: "不应写入",
    });
    expect(deniedWrite).toMatchObject({ details: { error: expect.stringContaining("源文件不在当前工作区") } });
    await expect(stat(join(libraryRoot, "设备规程.edited.docx"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await harness.close();
  }
});

async function selectedSessionRef(window: Parameters<typeof getDesktopState>[0]): Promise<SessionRef> {
  const state = await getDesktopState(window);
  if (!state.selectedWorkspaceId || !state.selectedSessionId) {
    throw new Error("Expected a selected session");
  }
  return { workspaceId: state.selectedWorkspaceId, sessionId: state.selectedSessionId };
}
