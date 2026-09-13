import { copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { createNamedThread, getDesktopState, launchPackagedDesktop, makeUserDataDir, makeWorkspace, runReadDocumentTool } from "../helpers/electron-app";
import { makeLongDocuments } from "../helpers/long-documents";

test("packaged document Worker reads PDF and long TXT, DOCX and XLSX tails from asar", async ({}, info) => {
  test.skip(process.env.PI_APP_TEST_PACKAGED_DOCUMENTS !== "1", "Explicit packaged document verification only.");
  const workspace = await makeWorkspace("打包文档 空格");
  const docs = await makeLongDocuments(workspace);
  const pdf = join(workspace, "标准文档.pdf");
  await copyFile(join(__dirname, "..", "fixtures", "documents", "standard-zh.pdf"), pdf);
  const harness = await launchPackagedDesktop(await makeUserDataDir("packaged-documents-"), { initialWorkspaces: [workspace], scrubProviderEnv: true, testMode: "background" });
  try {
    const page = await harness.firstWindow(); await createNamedThread(page, "Packaged document proof");
    const state = await getDesktopState(page), ref = { workspaceId: state.selectedWorkspaceId!, sessionId: state.selectedSessionId! };
    const appPath = await harness.electronApp.evaluate(({ app }) => app.getAppPath());
    expect(appPath).toMatch(/\.asar$/);
    for (const doc of docs) {
      const first = await runReadDocumentTool(harness, ref, { path: doc.path });
      expect(first.details).toMatchObject({ complete: true, totalParts: expect.any(Number) });
      const last = await runReadDocumentTool(harness, ref, { path: doc.path, part: first.details!.totalParts, source_version: first.details!.sourceVersion });
      expect(last.content[0]?.text).toContain(doc.marker);
    }
    const pdfText = await runReadDocumentTool(harness, ref, { path: pdf, part: 1 });
    expect(pdfText.details?.complete).toBe(true);
    expect(pdfText.content[0]?.text).toContain("第 3.2 条");
    await page.getByTestId("composer").fill("Packaged document UI remains usable");
    await page.screenshot({ path: info.outputPath("packaged-documents.png") });
  } finally { await harness.close(); }
});

test("packaged Worker startup failure returns a stable error and recovers with the packaged parser", async ({}, info) => {
  test.skip(process.env.PI_APP_TEST_PACKAGED_DOCUMENTS !== "1", "Explicit packaged document verification only.");
  const workspace = await makeWorkspace("打包故障恢复 空格");
  const path = join(workspace, "recovery.txt"); await writeFile(path, "PACKAGED_WORKER_RECOVERED");
  const harness = await launchPackagedDesktop(await makeUserDataDir("packaged-worker-failure-"), { initialWorkspaces: [workspace], scrubProviderEnv: true, testMode: "background",
    envOverrides: { PI_APP_TEST_DOCUMENT_WORKER_PATH: info.outputPath("missing-worker.mjs"), PI_APP_TEST_DOCUMENT_PARSE_MS: "2000" } });
  try {
    const page = await harness.firstWindow(); await createNamedThread(page, "Packaged failure proof");
    const state = await getDesktopState(page), ref = { workspaceId: state.selectedWorkspaceId!, sessionId: state.selectedSessionId! };
    expect((await runReadDocumentTool(harness, ref, { path })).details).toMatchObject({ errorCode: "DOCUMENT_WORKER_UNAVAILABLE" });
    await page.getByTestId("composer").fill("The app still responds after Worker failure");
    await expect(page.getByTestId("composer")).toHaveValue("The app still responds after Worker failure");
    // Test-owned fault injection ends here; retry must find the real packaged Worker.
    await harness.electronApp.evaluate(() => { delete process.env.PI_APP_TEST_DOCUMENT_WORKER_PATH; });
    const recovered = await runReadDocumentTool(harness, ref, { path });
    expect(recovered.content[0]?.text).toContain("PACKAGED_WORKER_RECOVERED");
    expect(recovered.details?.complete).toBe(true);
    await page.screenshot({ path: info.outputPath("packaged-worker-recovered.png") });
  } finally { await harness.close(); }
});
