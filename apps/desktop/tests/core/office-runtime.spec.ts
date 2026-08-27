import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import ExcelJS from "exceljs";
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
