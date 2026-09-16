import { readFile, stat } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { unzipSync } from "fflate";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  runOfficeComposeRuntimeTool,
} from "../helpers/electron-app";

// This spec drives `word_compose`/`word_template_inspect`/`word_template_fill`
// through the real Electron main process (registered tools, confirm dialog,
// plan-mode gate, atomic no-overwrite save) rather than calling the tool
// factories in-process - see tests/unit/office-compose.spec.ts for the
// broader in-process coverage of style profiles, Markdown input and
// validation errors, which does not need a full app launch.
test("word_compose creates a real Word document through the running app", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir("office-compose-");
  const workspacePath = await makeWorkspace("office-compose-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
    envOverrides: { PI_APP_DEFAULT_RUNTIME_MODE: "light" },
  });
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Office compose session");
    const state = await getDesktopState(window);
    if (!state.selectedWorkspaceId || !state.selectedSessionId) {
      throw new Error("Expected a selected office compose session");
    }
    const sessionRef = { workspaceId: state.selectedWorkspaceId, sessionId: state.selectedSessionId };

    const composed = await runOfficeComposeRuntimeTool(harness, sessionRef, "word_compose", {
      title: "验收测试文档",
      inputFormat: "blocks",
      styleProfileId: "report-zh",
      blocks: [
        { type: "heading", level: 1, text: "第一章 概述" },
        { type: "paragraph", text: "这是一段正文。" },
        { type: "table", columns: [{ title: "姓名" }, { title: "部门" }], rows: [["张三", "研发部"]] },
      ],
    });
    expect(composed).toMatchObject({ details: { format: "docx" } });
    const outputPath = (composed as { details?: { outputPath?: string } }).details?.outputPath;
    if (!outputPath) throw new Error("word_compose did not return an output path");
    expect((await stat(outputPath)).isFile()).toBe(true);
    const documentXml = new TextDecoder().decode(unzipSync(await readFile(outputPath))["word/document.xml"]);
    expect(documentXml).toContain("第一章 概述");
    expect(documentXml).toContain("张三");
  } finally {
    await harness.close();
  }
});
