import { copyFile, mkdir, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";
import { createNamedThread, getDesktopState, launchDesktop, makeUserDataDir, makeWorkspace, runLibraryRuntimeTool, runReadDocumentTool } from "../helpers/electron-app";
import { makeLongDocuments } from "../helpers/long-documents";

test("Electron reads and searches long document tails, rejects stale locators and symlink escapes", async ({}, info) => {
  const userDataDir = await makeUserDataDir();
  const workspace = await makeWorkspace("document-regressions");
  const library = info.outputPath("synthetic-library");
  const docs = await makeLongDocuments(library);
  await writeFile(join(userDataDir, "library.json"), JSON.stringify({ enabled: true, roots: [library] }));
  const harness = await launchDesktop(userDataDir, { initialWorkspaces: [workspace], testMode: "background", scrubProviderEnv: true });
  try {
    const page = await harness.firstWindow();
    await createNamedThread(page, "Document regression proof");
    const state = await getDesktopState(page);
    const ref = { workspaceId: state.selectedWorkspaceId!, sessionId: state.selectedSessionId! };
    await expect.poll(() => page.evaluate(() => window.piApp.getLibraryIndexStatus())).toMatchObject({ state: "ready", documents: 3 });
    for (const doc of docs) {
      const search = await runLibraryRuntimeTool(harness, "library_search", { query: doc.marker });
      const match = (search.details as any).results[0];
      expect(match).toMatchObject({ complete: true, snippet: expect.stringContaining(doc.marker) });
      const read = await runReadDocumentTool(harness, ref, { path: match.path, part: match.part, source_version: match.sourceVersion });
      expect(read.content[0]?.text).toContain(doc.marker);
      expect(read.details).toMatchObject({ complete: true, sourceVersion: match.sourceVersion });
      if (doc.kind === "xlsx") expect(read.content[0]?.text).toContain("Synthetic rows — rows");
      await writeFile(doc.path, "updated synthetic document");
      expect((await runReadDocumentTool(harness, ref, { path: match.path, part: match.part, source_version: match.sourceVersion })).details)
        .toMatchObject({ errorCode: "DOCUMENT_CHANGED" });
    }
    const pdf = join(workspace, "paged.pdf");
    await copyFile(resolve(__dirname, "../fixtures/documents/standard-zh.pdf"), pdf);
    const finalPage = await runReadDocumentTool(harness, ref, { path: pdf, part: 2 });
    expect(finalPage.content[0]?.text).toContain("机组启动前应完成全部保护投入试验");
    expect(finalPage.details).toMatchObject({ part: 2, totalParts: 2, unit: "page", complete: true });
    const outside = info.outputPath("not-authorized"); await mkdir(outside);
    await writeFile(join(outside, "secret.txt"), "must not be exposed");
    await symlink(outside, join(workspace, "escaped"), process.platform === "win32" ? "junction" : "dir");
    expect((await runReadDocumentTool(harness, ref, { path: join(workspace, "escaped", "secret.txt") })).details)
      .toMatchObject({ errorCode: "DOCUMENT_UNAUTHORIZED" });
    await page.getByTestId("composer").fill("Document tools verified with synthetic fixtures");
    await page.screenshot({ path: info.outputPath("document-surface.png") });
  } finally { await harness.close(); }
});

for (const fault of ["missing", "hang"] as const) {
  test(`Electron remains responsive after a ${fault} Worker and retries with the real parser`, async ({}, info) => {
    await mkdir(info.outputDir, { recursive: true });
    const workerPath = info.outputPath("fault-worker.mjs");
    if (fault === "hang") await writeFile(workerPath, "import {parentPort} from 'node:worker_threads'; parentPort.on('message', () => { while (true) {} });");
    const userDataDir = await makeUserDataDir(); const workspace = await makeWorkspace(`document-${fault}`);
    const doc = join(workspace, "recover.txt"); await writeFile(doc, "REAL_DOCUMENT_WORKER_RECOVERED");
    const harness = await launchDesktop(userDataDir, { initialWorkspaces: [workspace], testMode: "background", scrubProviderEnv: true,
      envOverrides: { PI_APP_TEST_DOCUMENT_WORKER_PATH: workerPath, PI_APP_TEST_DOCUMENT_PARSE_MS: "600" } });
    try {
      const page = await harness.firstWindow(); await createNamedThread(page, `Worker ${fault}`);
      const state = await getDesktopState(page);
      const ref = { workspaceId: state.selectedWorkspaceId!, sessionId: state.selectedSessionId! };
      const pending = runReadDocumentTool(harness, ref, { path: doc });
      await page.getByTestId("composer").fill("UI responds while parsing is pending");
      await expect(page.getByTestId("composer")).toHaveValue("UI responds while parsing is pending");
      expect((await pending).details).toMatchObject({ errorCode: fault === "hang" ? "DOCUMENT_PARSE_TIMEOUT" : "DOCUMENT_WORKER_UNAVAILABLE" });
      const appPath = await harness.electronApp.evaluate(({ app }) => app.getAppPath());
      await writeFile(workerPath, `import ${JSON.stringify(pathToFileURL(join(appPath, "out/main/document-worker.mjs")).href)};`);
      const retried = await runReadDocumentTool(harness, ref, { path: doc });
      expect(retried.content[0]?.text).toContain("REAL_DOCUMENT_WORKER_RECOVERED");
      expect(retried.details?.complete).toBe(true);
      await page.screenshot({ path: info.outputPath(`worker-${fault}-recovered.png`) });
    } finally { await harness.close(); }
  });
}
