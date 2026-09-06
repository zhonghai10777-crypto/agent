import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import ExcelJS from "exceljs";
import { unzipSync, zipSync } from "fflate";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  runOfficeRuntimeTool,
} from "../helpers/electron-app";
import { createExcelDocument, createWordDocument } from "../../electron/office-runtime";

test("light mode creates Word and edits Excel through the controlled office runtime", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir("office-runtime-");
  const workspacePath = await makeWorkspace("office-runtime-workspace");
  const sourceExcelPath = join(workspacePath, "budget.xlsx");
  const sourceWordPath = join(workspacePath, "notes.docx");
  await writeFile(sourceExcelPath, await createExcelDocument("数据", [["项目", "金额"], ["办公", 10]]));
  await writeFile(sourceWordPath, createWordDocument(undefined, ["原始内容"]));
  const originalExcelBytes = await readFile(sourceExcelPath);

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
    envOverrides: { PI_APP_DEFAULT_RUNTIME_MODE: "light" },
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Office runtime session");
    const state = await getDesktopState(window);
    if (!state.selectedWorkspaceId || !state.selectedSessionId) {
      throw new Error("Expected a selected office session");
    }
    const sessionRef = { workspaceId: state.selectedWorkspaceId, sessionId: state.selectedSessionId };

    const created = await runOfficeRuntimeTool(harness, sessionRef, "word_create", {
      title: "会议纪要",
      paragraphs: ["第一段", "第二段"],
    });
    expect(created).toMatchObject({ details: { format: "docx", changedItems: 3 } });
    const createdPath = (created as { details?: { outputPath?: string } }).details?.outputPath;
    if (!createdPath) throw new Error("Word tool did not return an output path");
    expect((await stat(createdPath)).isFile()).toBe(true);

    const edited = await runOfficeRuntimeTool(harness, sessionRef, "excel_update_cells", {
      sourcePath: sourceExcelPath,
      sheet: "数据",
      cells: { B2: 99 },
    });
    expect(edited).toMatchObject({ details: { format: "xlsx", changedItems: 1 } });
    const editedPath = (edited as { details?: { outputPath?: string } }).details?.outputPath;
    expect(editedPath).toBe(join(workspacePath, "budget.edited.xlsx"));
    expect((await stat(editedPath as string)).isFile()).toBe(true);
    expect(await readFile(sourceExcelPath)).toEqual(originalExcelBytes);
    const originalWorkbook = new ExcelJS.Workbook();
    await originalWorkbook.xlsx.load(await readFile(sourceExcelPath) as never);
    expect(originalWorkbook.getWorksheet("数据")?.getCell("B2").value).toBe(10);
    const editedWorkbook = new ExcelJS.Workbook();
    await editedWorkbook.xlsx.load(await readFile(editedPath as string) as never);
    expect(editedWorkbook.getWorksheet("数据")?.getCell("B2").value).toBe(99);
    expect((await stat(sourceWordPath)).isFile()).toBe(true);

    const unregisteredPath = join(workspacePath, "unregistered.docx");
    await writeFile(unregisteredPath, createWordDocument(undefined, ["not an office tool result"]));
    const openError = await window.evaluate(async (filePath) => {
      try {
        await window.piApp?.openOfficeFile(filePath);
        return "";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }, unregisteredPath);
    expect(openError).toContain("not a result created by this app session");
  } finally {
    await harness.close();
  }
});

test("Office repairs preserve explicit Excel values and replace Word text across runs in Electron", async ({}, testInfo) => {
  const workspacePath = await makeWorkspace("office-repair-workspace");
  const userDataDir = await makeUserDataDir("office-repair-");
  const excelPath = join(workspacePath, "values.xlsx");
  const wordPath = join(workspacePath, "contract.docx");
  await writeFile(excelPath, await createExcelDocument("数据", [[99, 99, 99, 99], [99, 99, 99, 99]]));
  const wordFiles = unzipSync(createWordDocument(undefined, ["合同金额"]));
  wordFiles["word/document.xml"] = new TextEncoder().encode(new TextDecoder().decode(wordFiles["word/document.xml"])
    .replace("合同金额", '合同</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>金额'));
  const originalWord = zipSync(wordFiles);
  await writeFile(wordPath, originalWord);
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath], testMode: "background", envOverrides: { PI_APP_DEFAULT_RUNTIME_MODE: "light" },
  });
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Office repair session");
    const state = await getDesktopState(window);
    const session = { workspaceId: state.selectedWorkspaceId!, sessionId: state.selectedSessionId! };
    // The existing Office harness invokes registered tools in the real main
    // process; deterministic model output and native Save As are outside this proof.
    const excel = await runOfficeRuntimeTool(harness, session, "excel_fill_range", {
      sourcePath: excelPath, sheet: "数据", range: "A1:D2", values: [[10, 0, false, ""], [null, 0, false, ""]],
    }) as { details: { outputPath: string; changedItems: number } };
    expect(excel.details.changedItems).toBe(8);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(excel.details.outputPath);
    expect(["A2", "B2", "C2", "D2"].map((cell) => workbook.getWorksheet("数据")?.getCell(cell).value)).toEqual([null, 0, false, ""]);

    const word = await runOfficeRuntimeTool(harness, session, "word_replace", {
      sourcePath: wordPath, search: "合同金额", replacement: "结算金额",
    }) as { details: { outputPath: string; changedItems: number } };
    expect(word.details.changedItems).toBe(1);
    const edited = new TextDecoder().decode(unzipSync(await readFile(word.details.outputPath))["word/document.xml"]);
    expect(edited).toContain("结算金额");
    expect(edited).toContain("<w:b/>");
    expect(new Uint8Array(await readFile(wordPath))).toEqual(originalWord);
    const missing = await runOfficeRuntimeTool(harness, session, "word_replace", {
      sourcePath: wordPath, search: "不存在的内容", replacement: "new",
    });
    expect(missing).toMatchObject({ details: { error: expect.stringContaining("未在文档中找到") } });
    await window.screenshot({ path: testInfo.outputPath("office-repair-session.png") });
  } finally {
    await harness.close();
  }
});
