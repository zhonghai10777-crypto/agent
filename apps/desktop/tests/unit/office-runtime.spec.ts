import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  appendWordContent,
  createExcelDocument,
  createOfficeRuntimeTools,
  createWordDocument,
  fillExcelRange,
  isOfficePathInScope,
  replaceWordText,
  updateExcelCells,
} from "../../electron/office-runtime";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import ExcelJS from "exceljs";
import { policyForRuntimeMode } from "../../electron/runtime-mode";

test("light-mode office policy allows officeMutation but not arbitrary fileMutation", () => {
  const policy = policyForRuntimeMode("light");
  expect(policy.officeMutation).toBe(true);
  expect(policy.fileMutation).toBe(false);
  expect(policy.terminal).toBe(false);
});

test("office paths only include workspace roots or explicit attachments", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-office-scope-"));
  expect(isOfficePathInScope(join(root, "report.docx"), { workspaceRoots: [root], allowedFiles: [] })).toBe(true);
  expect(isOfficePathInScope(join(root, "..", "report.docx"), { workspaceRoots: [root], allowedFiles: [] })).toBe(false);
  expect(isOfficePathInScope("/tmp/shared.xlsx", { workspaceRoots: [root], allowedFiles: ["/tmp/shared.xlsx"] })).toBe(true);
});

test("office writes require confirmation, reject plan mode, and never overwrite a conflicting target", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-office-write-"));
  const sourcePath = join(root, "report.docx");
  const outputPath = join(root, "report.edited.docx");
  await writeFile(sourcePath, createWordDocument(undefined, ["before"]));

  let confirmed = false;
  const cancelled = wordReplaceTool({
    root,
    confirmWrite: async () => confirmed,
  });
  const cancelledResult = await cancelled.execute("cancelled", {
    sourcePath,
    search: "before",
    replacement: "after",
  }, undefined, undefined, testExtensionContext(root));
  expect(cancelledResult.details).toMatchObject({ error: expect.stringContaining("取消") });
  await expect(readFile(outputPath)).rejects.toMatchObject({ code: "ENOENT" });

  const planBlocked = wordReplaceTool({
    root,
    getPermissionMode: () => "plan",
  });
  const planResult = await planBlocked.execute("plan", {
    sourcePath,
    search: "before",
    replacement: "after",
  }, undefined, undefined, testExtensionContext(root));
  expect(planResult.details).toMatchObject({ error: expect.stringContaining("plan") });

  confirmed = true;
  const sentinel = Buffer.from("do not overwrite");
  await writeFile(outputPath, sentinel);
  const conflictResult = await cancelled.execute("conflict", {
    sourcePath,
    search: "before",
    replacement: "after",
  }, undefined, undefined, testExtensionContext(root));
  expect(conflictResult.details).toMatchObject({ outputPath: join(root, "report.edited-2.docx") });
  expect(await readFile(outputPath)).toEqual(sentinel);
});

test("office source validation rejects symlink aliases", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-office-symlink-"));
  const sourcePath = join(root, "source.docx");
  const linkedPath = join(root, "linked.docx");
  await writeFile(sourcePath, createWordDocument(undefined, ["before"]));
  await symlink(sourcePath, linkedPath);
  const tool = wordReplaceTool({ root });
  const result = await tool.execute("symlink", {
    sourcePath: linkedPath,
    search: "before",
    replacement: "after",
  }, undefined, undefined, testExtensionContext(root));
  expect(result.details).toMatchObject({ error: expect.stringContaining("符号链接") });
});

test("Word create, replacement, and append preserve a valid OOXML package", () => {
  const created = createWordDocument("标题", ["原始内容"]);
  const replaced = replaceWordText(created, "原始内容", "替换内容");
  expect(replaced.changedItems).toBe(1);
  const appended = appendWordContent(replaced.buffer, { contentType: "paragraph", text: "追加内容" });
  expect(appended.changedItems).toBe(1);
  const { unzipSync } = require("fflate") as typeof import("fflate");
  const xml = new TextDecoder().decode(unzipSync(appended.buffer)["word/document.xml"]);
  expect(xml).toContain("替换内容");
  expect(xml).toContain("追加内容");
});

test("Excel cell and range mutations preserve workbook structure", async () => {
  const source = await createExcelDocument("数据", [["A", "B"], [1, 2]]);
  const updated = await updateExcelCells(source, { kind: "excel_update_cells", sourcePath: "x.xlsx", sheet: "数据", cells: { A2: 9, B2: { formula: "=A2*2", result: 18 } } });
  const filled = await fillExcelRange(updated.buffer, { kind: "excel_fill_range", sourcePath: "x.xlsx", sheet: "数据", range: "A3:B4", values: [[3, 4], [5, 6]] });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(filled.buffer as never);
  expect(workbook.getWorksheet("数据")?.getCell("A2").value).toBe(9);
  expect(workbook.getWorksheet("数据")?.getCell("B2").value).toMatchObject({ formula: "=A2*2" });
  expect(workbook.getWorksheet("数据")?.getCell("B4").value).toBe(6);
});

function wordReplaceTool(overrides: {
  readonly root: string;
  readonly confirmWrite?: () => Promise<boolean>;
  readonly getPermissionMode?: () => "plan" | "auto";
}) {
  const tool = createOfficeRuntimeTools({
    getScope: () => ({ workspaceRoots: [overrides.root], allowedFiles: [] }),
    chooseNewFilePath: async () => undefined,
    confirmWrite: overrides.confirmWrite ?? (async () => true),
    getPermissionMode: overrides.getPermissionMode ?? (() => "auto"),
  }).find((entry) => entry.name === "word_replace");
  if (!tool) throw new Error("word_replace tool missing");
  return tool;
}

function testExtensionContext(cwd: string): ExtensionContext {
  return {
    hasUI: false,
    mode: "json",
    cwd,
    sessionManager: {
      getSessionId: () => "office-test-session",
      getCwd: () => cwd,
    } as ExtensionContext["sessionManager"],
    ui: {} as ExtensionContext["ui"],
    modelRegistry: {} as ExtensionContext["modelRegistry"],
    model: undefined,
    signal: undefined,
    isIdle: () => true,
    isProjectTrusted: () => true,
    abort: () => undefined,
    hasPendingMessages: () => false,
    shutdown: () => undefined,
    getContextUsage: () => undefined,
    compact: () => undefined,
    getSystemPrompt: () => "",
  };
}
