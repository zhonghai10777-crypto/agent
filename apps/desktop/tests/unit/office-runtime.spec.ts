import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { unzipSync, zipSync } from "fflate";
import {
  appendWordContent,
  createExcelDocument,
  createOfficeRuntimeTools,
  createWordDocument,
  fillExcelRange,
  formatExcelCells,
  isOfficePathInScope,
  mergeExcelCells,
  replaceWordText,
  setExcelColumnWidth,
  updateExcelCells,
} from "../../electron/office-runtime";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import ExcelJS from "exceljs";
import { policyForRuntimeMode } from "../../electron/runtime-mode";
import { replaceWordDocumentXml } from "../../electron/office-word-text";
import { DOMParser } from "@xmldom/xmldom";

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

  const libraryRoot = join(root, "library");
  const libraryFile = join(libraryRoot, "standard.docx");
  expect(
    isOfficePathInScope(libraryFile, {
      workspaceRoots: [root],
      allowedFiles: [libraryFile],
      readOnlyRoots: [libraryRoot],
    }),
  ).toBe(false);
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
  const appendedParagraph = appendWordContent(replaced.buffer, { contentType: "paragraph", text: "追加内容" });
  const appended = appendWordContent(appendedParagraph.buffer, { contentType: "list", items: ["列表项"] });
  expect(appended.changedItems).toBe(1);
  const { unzipSync } = require("fflate") as typeof import("fflate");
  const xml = new TextDecoder().decode(unzipSync(appended.buffer)["word/document.xml"]);
  expect(xml).toContain("替换内容");
  expect(xml).toContain("追加内容");
  expect(xml).toContain("w:numId w:val=\"1\"");
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

test("Excel fill round-trips null, zero, false and empty strings without copying the first row", async ({}, testInfo) => {
  const source = await createExcelDocument("数据", [[99, 99, 99, 99], [99, 99, 99, 99]]);
  const values = [[10, 0, false, ""], [null, 0, false, ""]];
  const filled = await fillExcelRange(source, {
    kind: "excel_fill_range", sourcePath: "values.xlsx", sheet: "数据", range: "A1:D2", values,
  });
  const root = await mkdtemp(join(tmpdir(), "pi-office-values-"));
  const saved = join(root, "values.xlsx");
  await writeFile(saved, filled.buffer);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(saved);
  for (let row = 0; row < values.length; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      expect(workbook.getWorksheet("数据")?.getCell(row + 1, column + 1).value).toBe(values[row]![column]);
    }
  }
  expect(filled.changedItems).toBe(8);
  await testInfo.attach("round-trip-workbook", { path: saved, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
});

test("Excel scalar and one-dimensional fill shapes preserve explicit empty values", async () => {
  const source = await createExcelDocument("数据", [[1, 2], [3, 4]]);
  for (const values of [null, 0, false, ""]) {
    const result = await fillExcelRange(source, { kind: "excel_fill_range", sourcePath: "x.xlsx", sheet: "数据", range: "A1:B2", values });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(result.buffer as never);
    expect(workbook.getWorksheet("数据")?.getCell("B2").value).toBe(values);
  }
  for (const range of ["A1:B1", "A1:A2"]) {
    const result = await fillExcelRange(source, { kind: "excel_fill_range", sourcePath: "x.xlsx", sheet: "数据", range, values: [10, null] });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(result.buffer as never);
    expect(workbook.getWorksheet("数据")?.getCell(range.endsWith("B1") ? "B1" : "A2").value).toBeNull();
  }
});

test("Excel fill rejects ragged, incomplete and mixed matrices", async () => {
  const source = await createExcelDocument("数据", [[1, 2], [3, 4]]);
  for (const values of [[[1]], [[1, 2], [3]], [[1, 2], 3], [[1, 2], [3, undefined]], [[1, 2], new Array(2)], []]) {
    await expect(fillExcelRange(source, {
      kind: "excel_fill_range", sourcePath: "x.xlsx", sheet: "数据", range: "A1:B2", values,
    })).rejects.toThrow(/values/);
  }
});

const wordNs = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const wordXml = (body: string) => `<w:document xmlns:w="${wordNs}"><w:body>${body}</w:body></w:document>`;

test("Word replacement crosses formatted runs and handles multiple matches in a paragraph and table", () => {
  const paragraph = '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>合同</w:t></w:r><w:r><w:t>金额，合同</w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>金额。</w:t></w:r></w:p>';
  const xml = wordXml(paragraph + `<w:tbl><w:tr><w:tc>${paragraph}</w:tc></w:tr></w:tbl>`);
  const result = replaceWordDocumentXml(xml, "合同金额", "费用");
  expect(result.changedItems).toBe(4);
  const parsed = new DOMParser().parseFromString(result.xml, "application/xml");
  const paragraphs = Array.from(parsed.getElementsByTagNameNS(wordNs, "p"));
  expect(paragraphs.map((item) => item.textContent)).toEqual(["费用，费用。", "费用，费用。"]);
  expect(parsed.getElementsByTagNameNS(wordNs, "b").length).toBe(2);
  expect(parsed.getElementsByTagNameNS(wordNs, "i").length).toBe(2);
});

test("Word replacement respects paragraph, cell, field and visible break boundaries", () => {
  const text = (value: string) => `<w:r><w:t>${value}</w:t></w:r>`;
  const body = [
    `<w:p>${text("合同")}</w:p><w:p>${text("金额")}</w:p>`,
    ...["tab", "br", "cr", "fldChar", "drawing"].map((barrier) => `<w:p>${text("合同")}<w:r><w:${barrier}/></w:r>${text("金额")}</w:p>`),
    `<w:tbl><w:tr><w:tc><w:p>${text("合同")}</w:p></w:tc><w:tc><w:p>${text("金额")}</w:p></w:tc></w:tr></w:tbl>`,
  ].join("");
  const xml = wordXml(body);
  expect(replaceWordDocumentXml(xml, "合同金额", "费用")).toEqual({ xml, changedItems: 0 });
});

test("Word XML parsing handles namespace prefixes, entities, spaces and malformed input", () => {
  const xml = wordXml('<w:p><w:r><w:t xml:space="default">A&amp;</w:t></w:r><w:r><w:t>&#66;</w:t></w:r></w:p>')
    .replaceAll("w:", "word:").replace("xmlns:w=", "xmlns:word=");
  const result = replaceWordDocumentXml(xml, "A&B", " <费用> ");
  expect(result.changedItems).toBe(1);
  const parsed = new DOMParser().parseFromString(result.xml, "application/xml");
  const text = parsed.getElementsByTagNameNS(wordNs, "t")[0]!;
  expect(text.textContent).toBe(" <费用> ");
  expect(text.getAttribute("xml:space")).toBe("preserve");
  expect(() => replaceWordDocumentXml("<w:document><w:p>", "x", "y")).toThrow(/XML/);
  expect(() => replaceWordDocumentXml(xml, "", "y")).toThrow(/non-empty/);
});

test("Word round-trip preserves other OOXML parts and the source file", async () => {
  const files = unzipSync(createWordDocument("标题", ["before"]));
  const xml = new TextDecoder().decode(files["word/document.xml"]);
  files["word/document.xml"] = new TextEncoder().encode(xml.replace("before", "合同</w:t></w:r><w:r><w:t>金额"));
  const source = zipSync(files);
  const result = replaceWordText(source, "合同金额", "新金额");
  expect(result.changedItems).toBe(1);
  const root = await mkdtemp(join(tmpdir(), "pi-word-roundtrip-"));
  const saved = join(root, "edited.docx");
  await writeFile(saved, result.buffer);
  const reopened = unzipSync(await readFile(saved));
  expect(new TextDecoder().decode(reopened["word/document.xml"])).toContain("新金额");
  for (const part of Object.keys(files).filter((part) => part !== "word/document.xml")) {
    expect(reopened[part]).toEqual(files[part]);
  }
  expect(unzipSync(source)["word/document.xml"]).toEqual(files["word/document.xml"]);
});

test("Word no-match returns a clear error without confirming or saving a copy", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-word-no-match-"));
  const sourcePath = join(root, "source.docx");
  await writeFile(sourcePath, createWordDocument(undefined, ["original"]));
  let confirmations = 0;
  const tool = wordReplaceTool({ root, confirmWrite: async () => { confirmations += 1; return true; } });
  const result = await tool.execute("no-match", { sourcePath, search: "missing", replacement: "new" }, undefined, undefined, testExtensionContext(root));
  expect(result.details).toMatchObject({ error: expect.stringContaining("未在文档中找到") });
  expect(confirmations).toBe(0);
  await expect(readFile(join(root, "source.edited.docx"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("Excel formatting, merge, and column width operations preserve requested layout", async () => {
  const source = await createExcelDocument("数据", [["标题", "金额"], ["项目", 10]]);
  const formatted = await formatExcelCells(source, {
    kind: "excel_format_cells",
    sourcePath: "x.xlsx",
    sheet: "数据",
    range: "A1:B1",
    bold: true,
    fillColor: "#DDEEFF",
    horizontalAlignment: "center",
    numberFormat: "#,##0.00",
  });
  const merged = await mergeExcelCells(formatted.buffer, {
    kind: "excel_merge_cells",
    sourcePath: "x.xlsx",
    sheet: "数据",
    range: "A3:B3",
  });
  const resized = await setExcelColumnWidth(merged.buffer, {
    kind: "excel_set_column_width",
    sourcePath: "x.xlsx",
    sheet: "数据",
    column: "A",
    width: 24,
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(resized.buffer as never);
  const worksheet = workbook.getWorksheet("数据");
  expect(worksheet?.getCell("A1").font.bold).toBe(true);
  expect(worksheet?.getCell("A1").fill).toMatchObject({ fgColor: { argb: "FFDDEEFF" } });
  expect(worksheet?.getCell("A1").alignment.horizontal).toBe("center");
  expect(worksheet?.getCell("A1").numFmt).toBe("#,##0.00");
  expect(worksheet?.getCell("A3").isMerged).toBe(true);
  expect(worksheet?.getColumn(1).width).toBe(24);
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
