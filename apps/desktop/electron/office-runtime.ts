import { randomUUID } from "node:crypto";
import { link, lstat, open, readFile, realpath, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { zipSync, unzipSync } from "fflate";
import ExcelJS from "exceljs";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { stringParam, toolErrorMessage } from "./tool-params";
import { replaceWordDocumentXml } from "./office-word-text";

export type OfficeFormat = "docx" | "xlsx";
export type OfficeOperation =
  | WordCreateOperation
  | WordReplaceOperation
  | WordAppendOperation
  | ExcelCreateOperation
  | ExcelUpdateCellsOperation
  | ExcelFillRangeOperation
  | ExcelAddSheetOperation
  | ExcelFormatCellsOperation
  | ExcelMergeCellsOperation
  | ExcelSetColumnWidthOperation;

export interface WordCreateOperation {
  readonly kind: "word_create";
  readonly title?: string;
  readonly paragraphs?: readonly string[];
}
export interface WordReplaceOperation {
  readonly kind: "word_replace";
  readonly sourcePath: string;
  readonly search: string;
  readonly replacement: string;
}
export interface WordAppendOperation {
  readonly kind: "word_append";
  readonly sourcePath: string;
  readonly contentType: "heading" | "paragraph" | "list" | "table";
  readonly headingLevel?: 1 | 2 | 3;
  readonly text?: string;
  readonly items?: readonly string[];
  readonly rows?: readonly (readonly string[])[];
}
export interface ExcelCreateOperation {
  readonly kind: "excel_create";
  readonly sheetName?: string;
  readonly rows?: readonly (readonly unknown[])[];
}
export interface ExcelUpdateCellsOperation {
  readonly kind: "excel_update_cells";
  readonly sourcePath: string;
  readonly sheet: string;
  readonly cells: Readonly<Record<string, unknown>>;
}
export interface ExcelFillRangeOperation {
  readonly kind: "excel_fill_range";
  readonly sourcePath: string;
  readonly sheet: string;
  readonly range: string;
  readonly values: unknown;
}
export interface ExcelAddSheetOperation {
  readonly kind: "excel_add_sheet";
  readonly sourcePath: string;
  readonly sheet: string;
}
export interface ExcelFormatCellsOperation {
  readonly kind: "excel_format_cells";
  readonly sourcePath: string;
  readonly sheet: string;
  readonly range: string;
  readonly numberFormat?: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly fontColor?: string;
  readonly fillColor?: string;
  readonly horizontalAlignment?: "left" | "center" | "right";
  readonly verticalAlignment?: "top" | "middle" | "bottom";
  readonly wrapText?: boolean;
}
export interface ExcelMergeCellsOperation {
  readonly kind: "excel_merge_cells";
  readonly sourcePath: string;
  readonly sheet: string;
  readonly range: string;
}
export interface ExcelSetColumnWidthOperation {
  readonly kind: "excel_set_column_width";
  readonly sourcePath: string;
  readonly sheet: string;
  readonly column: string;
  readonly width: number;
}

export interface OfficeWriteResult {
  readonly format: OfficeFormat;
  readonly sourcePath?: string;
  readonly outputPath: string;
  readonly summary: string;
  readonly changedItems: number;
}

export interface OfficeAccessScope {
  readonly workspaceRoots: readonly string[];
  readonly allowedFiles: readonly string[];
  /** Paths under these roots stay immutable even if also covered by a workspace or attachment grant. */
  readonly readOnlyRoots?: readonly string[];
}

export interface OfficeRuntimeOptions {
  readonly getScope: (ctx: ExtensionContext) => OfficeAccessScope;
  readonly chooseNewFilePath: (format: OfficeFormat) => Promise<string | undefined>;
  readonly confirmWrite?: (
    ctx: ExtensionContext,
    summary: string,
    outputPath: string,
    changedItems: number,
  ) => Promise<boolean>;
  readonly onWriteComplete?: (result: OfficeWriteResult) => void | Promise<void>;
  readonly assertAllowed?: () => void;
  readonly getPermissionMode?: (ctx: ExtensionContext) => "plan" | "auto";
}

const MAX_OFFICE_BYTES = 50 * 1024 * 1024;
const WORD_TOOLS = ["word_create", "word_replace", "word_append"] as const;
const EXCEL_TOOLS = [
  "excel_create",
  "excel_update_cells",
  "excel_fill_range",
  "excel_add_sheet",
  "excel_format_cells",
  "excel_merge_cells",
  "excel_set_column_width",
] as const;
export const officeToolNames = [...WORD_TOOLS, ...EXCEL_TOOLS] as const;

export function isOfficePathInScope(target: string, scope: OfficeAccessScope): boolean {
  const resolved = path.resolve(target);
  if (scope.readOnlyRoots?.some((root) => isPathAtOrBelow(resolved, root))) {
    return false;
  }
  if (scope.allowedFiles.some((file) => path.resolve(file) === resolved)) {
    return true;
  }
  return scope.workspaceRoots.some((root) => {
    const relative = path.relative(path.resolve(root), resolved);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  });
}

function isPathAtOrBelow(target: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function nextEditedPath(sourcePath: string): string {
  const extension = path.extname(sourcePath);
  const stem = sourcePath.slice(0, -extension.length);
  return `${stem}.edited${extension}`;
}

export function conflictFreeEditedPath(sourcePath: string, existing: readonly string[] = []): string {
  const used = new Set(existing.map((value) => path.resolve(value)));
  let candidate = nextEditedPath(sourcePath);
  let index = 2;
  while (used.has(path.resolve(candidate))) {
    candidate = `${sourcePath.slice(0, -path.extname(sourcePath).length)}.edited-${index}${path.extname(sourcePath)}`;
    index += 1;
  }
  return candidate;
}

export function createWordDocument(title?: string, paragraphs: readonly string[] = []): Uint8Array {
  const body = [
    ...(title ? [wordParagraph(title, "Heading1")] : []),
    ...paragraphs.map((paragraph) => wordParagraph(paragraph)),
    "<w:sectPr><w:pgSz w:w=\"12240\" w:h=\"15840\"/><w:pgMar w:top=\"1440\" w:right=\"1440\" w:bottom=\"1440\" w:left=\"1440\"/></w:sectPr>",
  ].join("");
  return zipSync(wordPackage(documentXml(body)));
}

export function replaceWordText(buffer: Uint8Array, search: string, replacement: string): { buffer: Uint8Array; changedItems: number } {
  if (!search) {
    throw new Error("word_replace requires non-empty search text.");
  }
  const files = unzipSync(buffer);
  const document = readZipText(files, "word/document.xml");
  const result = replaceWordDocumentXml(document, search, replacement);
  if (result.changedItems === 0) {
    return { buffer, changedItems: 0 };
  }
  files["word/document.xml"] = new TextEncoder().encode(result.xml);
  return { buffer: zipSync(files), changedItems: result.changedItems };
}


export function appendWordContent(
  buffer: Uint8Array,
  operation: Pick<WordAppendOperation, "contentType" | "headingLevel" | "text" | "items" | "rows">,
): { buffer: Uint8Array; changedItems: number } {
  const files = unzipSync(buffer);
  const document = readZipText(files, "word/document.xml");
  const insertion = wordAppendXml(operation);
  if (!insertion) {
    throw new Error("word_append requires supported content.");
  }
  const sectionStart = document.lastIndexOf("<w:sectPr");
  if (sectionStart < 0) {
    throw new Error("The Word document has no supported section structure.");
  }
  const nextDocument = `${document.slice(0, sectionStart)}${insertion}${document.slice(sectionStart)}`;
  files["word/document.xml"] = new TextEncoder().encode(nextDocument);
  if (operation.contentType === "list") ensureWordNumbering(files);
  const changedItems = operation.contentType === "table" ? operation.rows?.length ?? 0 : operation.items?.length ?? 1;
  return { buffer: zipSync(files), changedItems: Math.max(1, changedItems) };
}

export async function createExcelDocument(
  sheetName = "Sheet1",
  rows: readonly (readonly unknown[])[] = [],
): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet(safeSheetName(sheetName));
  for (const row of rows) worksheet.addRow([...row]);
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

export async function updateExcelCells(
  buffer: Uint8Array,
  operation: ExcelUpdateCellsOperation,
): Promise<{ buffer: Uint8Array; changedItems: number }> {
  const workbook = await loadWorkbook(buffer);
  const worksheet = workbook.getWorksheet(operation.sheet);
  if (!worksheet) throw new Error(`Worksheet not found: ${operation.sheet}`);
  let changedItems = 0;
  for (const [address, value] of Object.entries(operation.cells)) {
    worksheet.getCell(address).value = normalizeExcelValue(value);
    changedItems += 1;
  }
  return { buffer: new Uint8Array(await workbook.xlsx.writeBuffer()), changedItems };
}

export async function fillExcelRange(
  buffer: Uint8Array,
  operation: ExcelFillRangeOperation,
): Promise<{ buffer: Uint8Array; changedItems: number }> {
  const workbook = await loadWorkbook(buffer);
  const worksheet = workbook.getWorksheet(operation.sheet);
  if (!worksheet) throw new Error(`Worksheet not found: ${operation.sheet}`);
  const range = parseRange(operation.range);
  const matrix = resolveFillMatrix(operation.values, range, operation.range);
  let changedItems = 0;
  for (let row = 0; row < range.height; row += 1) {
    for (let column = 0; column < range.width; column += 1) {
      const value = (matrix[row] as readonly unknown[])[column];
      worksheet.getCell(range.startRow + row, range.startColumn + column).value = normalizeExcelValue(value);
      changedItems += 1;
    }
  }
  return { buffer: new Uint8Array(await workbook.xlsx.writeBuffer()), changedItems };
}

/**
 * Expand `values` into exactly one value per cell of `range`.
 *
 * Three accepted shapes, all explicit: a scalar (repeated over the range), a
 * matrix matching the range exactly, or a flat list for a single-row or
 * single-column range. A matrix that does not match the range is an error
 * rather than something to pad — the old "fall back to the first row" rule
 * turned a deliberate `null` (clear this cell) into a copy of the cell above
 * it, which is silently wrong data rather than a visible failure.
 */
function resolveFillMatrix(
  values: unknown,
  range: { readonly width: number; readonly height: number },
  rangeText: string,
): readonly (readonly unknown[])[] {
  if (!Array.isArray(values)) {
    if (values === undefined) throw new Error("values 缺少值；请用 null 明确清空单元格。");
    return Array.from({ length: range.height }, () => Array.from({ length: range.width }, () => values));
  }

  const entries = values as readonly unknown[];
  if (Array.from(entries).some((entry) => entry === undefined)) {
    throw new Error("values 缺少值；请用 null 明确清空单元格。");
  }
  const rowCount = entries.filter((entry) => Array.isArray(entry)).length;
  if (rowCount > 0 && rowCount !== entries.length) {
    throw new Error(`excel_fill_range 的 values 不能混用单值和数组行；请传标量、完整二维数组，或一维列表。`);
  }

  if (rowCount > 0) {
    if (entries.length !== range.height) {
      throw new Error(`values 有 ${entries.length} 行，范围 ${rangeText} 需要 ${range.height} 行。`);
    }
    return entries.map((row, index) => {
      const cells = row as readonly unknown[];
      if (cells.length !== range.width) {
        throw new Error(`values 第 ${index + 1} 行有 ${cells.length} 列，范围 ${rangeText} 需要 ${range.width} 列。`);
      }
      if (Array.from(cells).some((cell) => cell === undefined)) {
        throw new Error(`values 第 ${index + 1} 行缺少值；请用 null 明确清空单元格。`);
      }
      return cells;
    });
  }

  if (range.height === 1 && entries.length === range.width) {
    return [entries];
  }
  if (range.width === 1 && entries.length === range.height) {
    return entries.map((entry) => [entry]);
  }
  throw new Error(
    `values 是 ${entries.length} 个值的一维列表，只能填充 1 行 ${range.width} 列或 ${range.height} 行 1 列的范围；范围 ${rangeText} 需要 ${range.height} 行 ${range.width} 列。`,
  );
}

export async function addExcelSheet(
  buffer: Uint8Array,
  sheet: string,
): Promise<{ buffer: Uint8Array; changedItems: number }> {
  const workbook = await loadWorkbook(buffer);
  if (!sheet.trim()) throw new Error("excel_add_sheet requires a sheet name.");
  if (workbook.getWorksheet(sheet)) throw new Error(`Worksheet already exists: ${sheet}`);
  workbook.addWorksheet(safeSheetName(sheet));
  return { buffer: new Uint8Array(await workbook.xlsx.writeBuffer()), changedItems: 1 };
}

export async function formatExcelCells(
  buffer: Uint8Array,
  operation: ExcelFormatCellsOperation,
): Promise<{ buffer: Uint8Array; changedItems: number }> {
  const workbook = await loadWorkbook(buffer);
  const worksheet = workbook.getWorksheet(operation.sheet);
  if (!worksheet) throw new Error(`Worksheet not found: ${operation.sheet}`);
  const range = parseRange(operation.range);
  const fontColor = operation.fontColor ? normalizeExcelColor(operation.fontColor) : undefined;
  const fillColor = operation.fillColor ? normalizeExcelColor(operation.fillColor) : undefined;
  for (let row = 0; row < range.height; row += 1) {
    for (let column = 0; column < range.width; column += 1) {
      const cell = worksheet.getCell(range.startRow + row, range.startColumn + column);
      if (operation.numberFormat !== undefined) cell.numFmt = operation.numberFormat;
      if (operation.bold !== undefined || operation.italic !== undefined || fontColor) {
        cell.font = {
          ...cell.font,
          ...(operation.bold !== undefined ? { bold: operation.bold } : {}),
          ...(operation.italic !== undefined ? { italic: operation.italic } : {}),
          ...(fontColor ? { color: { argb: fontColor } } : {}),
        };
      }
      if (fillColor) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fillColor } };
      }
      if (operation.horizontalAlignment || operation.verticalAlignment || operation.wrapText !== undefined) {
        cell.alignment = {
          ...cell.alignment,
          ...(operation.horizontalAlignment ? { horizontal: operation.horizontalAlignment } : {}),
          ...(operation.verticalAlignment ? { vertical: operation.verticalAlignment } : {}),
          ...(operation.wrapText !== undefined ? { wrapText: operation.wrapText } : {}),
        };
      }
    }
  }
  return { buffer: new Uint8Array(await workbook.xlsx.writeBuffer()), changedItems: range.width * range.height };
}

export async function mergeExcelCells(
  buffer: Uint8Array,
  operation: ExcelMergeCellsOperation,
): Promise<{ buffer: Uint8Array; changedItems: number }> {
  const workbook = await loadWorkbook(buffer);
  const worksheet = workbook.getWorksheet(operation.sheet);
  if (!worksheet) throw new Error(`Worksheet not found: ${operation.sheet}`);
  const range = parseRange(operation.range);
  worksheet.mergeCells(operation.range);
  return { buffer: new Uint8Array(await workbook.xlsx.writeBuffer()), changedItems: range.width * range.height };
}

export async function setExcelColumnWidth(
  buffer: Uint8Array,
  operation: ExcelSetColumnWidthOperation,
): Promise<{ buffer: Uint8Array; changedItems: number }> {
  const workbook = await loadWorkbook(buffer);
  const worksheet = workbook.getWorksheet(operation.sheet);
  if (!worksheet) throw new Error(`Worksheet not found: ${operation.sheet}`);
  const column = operation.column.trim();
  if (!/^[A-Z]+$/i.test(column)) throw new Error(`非法 Excel 列：${operation.column}`);
  if (!Number.isFinite(operation.width) || operation.width <= 0 || operation.width > 255) {
    throw new Error("Excel 列宽必须在 0 到 255 之间。");
  }
  worksheet.getColumn(columnNumber(column)).width = operation.width;
  return { buffer: new Uint8Array(await workbook.xlsx.writeBuffer()), changedItems: 1 };
}

export function createOfficeRuntimeTools(
  options: OfficeRuntimeOptions,
): readonly ToolDefinition<any, OfficeWriteResult | { error: string }>[] {
  return [
    createWordCreateTool(options),
    createWordReplaceTool(options),
    createWordAppendTool(options),
    createExcelCreateTool(options),
    createExcelUpdateTool(options),
    createExcelFillTool(options),
    createExcelAddSheetTool(options),
    createExcelFormatTool(options),
    createExcelMergeTool(options),
    createExcelSetColumnWidthTool(options),
  ];
}

export function createOfficeRuntimeExtension(options: OfficeRuntimeOptions): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    for (const tool of createOfficeRuntimeTools(options)) pi.registerTool(tool);
  };
}

function createWordCreateTool(options: OfficeRuntimeOptions): ToolDefinition<any, OfficeWriteResult | { error: string }> {
  return {
    name: "word_create",
    label: "Create Word document",
    description: "Create a simple Word document with an optional title and paragraphs. The file is saved after confirmation.",
    promptSnippet: "word_create: create a simple Word document.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        paragraphs: { type: "array", items: { type: "string" } },
      },
    },
    async execute(_id, params, _signal, _update, ctx) {
      return runOfficeWrite(options, ctx, "docx", undefined, async (outputPath) => {
        const title = stringParam(params, "title");
        const paragraphs = stringArrayParam(params, "paragraphs");
        const buffer = createWordDocument(title, paragraphs);
        return {
          buffer,
          changedItems: Math.max(1, paragraphs.length + (title ? 1 : 0)),
          summary: `新建 Word 文档${title ? `《${title}》` : ""}`,
          outputPath,
        };
      });
    },
  };
}

function createWordReplaceTool(options: OfficeRuntimeOptions): ToolDefinition<any, OfficeWriteResult | { error: string }> {
  return {
    name: "word_replace",
    label: "Replace Word text",
    description: "Replace exact text in a Word document and save an edited copy beside the source.",
    promptSnippet: "word_replace: replace exact text in a Word document.",
    parameters: {
      type: "object",
      properties: {
        sourcePath: { type: "string" },
        search: { type: "string" },
        replacement: { type: "string" },
      },
      required: ["sourcePath", "search", "replacement"],
    },
    async execute(_id, params, _signal, _update, ctx) {
      const sourcePath = stringParam(params, "sourcePath");
      const search = stringParam(params, "search");
      const replacement = typeof (params as Record<string, unknown>)?.replacement === "string" ? String((params as Record<string, unknown>).replacement) : "";
      if (!sourcePath || !search) return officeError("word_replace requires sourcePath and search.");
      return runOfficeWrite(options, ctx, "docx", sourcePath, async (outputPath, source) => {
        const result = replaceWordText(source ?? new Uint8Array(), search, replacement);
        if (result.changedItems === 0) {
          // Saving an untouched copy looks like a successful edit; say plainly
          // that the text is not in the document instead.
          throw new Error(`未在文档中找到“${search}”，没有可替换的内容，因此没有另存文件。`);
        }
        return { buffer: result.buffer, changedItems: result.changedItems, summary: `替换 Word 文本 ${result.changedItems} 处`, outputPath };
      });
    },
  };
}

function createWordAppendTool(options: OfficeRuntimeOptions): ToolDefinition<any, OfficeWriteResult | { error: string }> {
  return {
    name: "word_append",
    label: "Append Word content",
    description: "Append a heading, paragraph, list, or simple table to a Word document and save an edited copy.",
    promptSnippet: "word_append: append supported content to a Word document.",
    parameters: {
      type: "object",
        properties: {
          sourcePath: { type: "string" },
          contentType: { type: "string", enum: ["heading", "paragraph", "list", "table"] },
          headingLevel: { type: "integer", minimum: 1, maximum: 3 },
          text: { type: "string" },
        items: { type: "array", items: { type: "string" } },
        rows: { type: "array", items: { type: "array", items: { type: "string" } } },
      },
      required: ["sourcePath", "contentType"],
    },
    async execute(_id, params, _signal, _update, ctx) {
      const sourcePath = stringParam(params, "sourcePath");
      const contentType = stringParam(params, "contentType") as WordAppendOperation["contentType"] | undefined;
      if (!sourcePath || !contentType || !["heading", "paragraph", "list", "table"].includes(contentType)) {
        return officeError("word_append requires sourcePath and a supported contentType.");
      }
      return runOfficeWrite(options, ctx, "docx", sourcePath, async (outputPath, source) => {
        const op = {
          contentType,
          headingLevel: typeof (params as Record<string, unknown>).headingLevel === "number"
            ? Math.min(3, Math.max(1, Math.trunc((params as Record<string, unknown>).headingLevel as number))) as 1 | 2 | 3
            : undefined,
          text: stringParam(params, "text"),
          items: stringArrayParam(params, "items"),
          rows: arrayRowsParam(params, "rows").map((row) => row.map((value) => String(value))),
        };
        const result = appendWordContent(source ?? new Uint8Array(), op);
        return { buffer: result.buffer, changedItems: result.changedItems, summary: `追加 Word ${contentType}`, outputPath };
      });
    },
  };
}

function createExcelCreateTool(options: OfficeRuntimeOptions): ToolDefinition<any, OfficeWriteResult | { error: string }> {
  return {
    name: "excel_create",
    label: "Create Excel workbook",
    description: "Create an Excel workbook with one sheet and optional rows. The file is saved after confirmation.",
    promptSnippet: "excel_create: create an Excel workbook.",
    parameters: {
      type: "object",
      properties: {
        sheetName: { type: "string" },
        rows: { type: "array", items: { type: "array" } },
      },
    },
    async execute(_id, params, _signal, _update, ctx) {
      return runOfficeWrite(options, ctx, "xlsx", undefined, async (outputPath) => {
        const sheetName = stringParam(params, "sheetName") ?? "Sheet1";
        const rows = arrayRowsParam(params, "rows");
        const buffer = await createExcelDocument(sheetName, rows);
        return { buffer, changedItems: Math.max(1, rows.length), summary: `新建 Excel 工作簿（工作表：${sheetName}）`, outputPath };
      });
    },
  };
}

function createExcelUpdateTool(options: OfficeRuntimeOptions): ToolDefinition<any, OfficeWriteResult | { error: string }> {
  return {
    name: "excel_update_cells",
    label: "Update Excel cells",
    description: "Update specified Excel cells with values or basic formulas and save an edited copy.",
    promptSnippet: "excel_update_cells: update specified Excel cells.",
    parameters: {
      type: "object",
      properties: {
        sourcePath: { type: "string" },
        sheet: { type: "string" },
        cells: { type: "object", additionalProperties: true },
      },
      required: ["sourcePath", "sheet", "cells"],
    },
    async execute(_id, params, _signal, _update, ctx) {
      const sourcePath = stringParam(params, "sourcePath");
      const sheet = stringParam(params, "sheet");
      const cells = recordParam(params, "cells");
      if (!sourcePath || !sheet || !cells) return officeError("excel_update_cells requires sourcePath, sheet and cells.");
      return runOfficeWrite(options, ctx, "xlsx", sourcePath, async (outputPath, source) => {
        const result = await updateExcelCells(source ?? new Uint8Array(), { kind: "excel_update_cells", sourcePath, sheet, cells });
        return { buffer: result.buffer, changedItems: result.changedItems, summary: `修改 Excel ${sheet} 工作表 ${result.changedItems} 个单元格`, outputPath };
      });
    },
  };
}

function createExcelFillTool(options: OfficeRuntimeOptions): ToolDefinition<any, OfficeWriteResult | { error: string }> {
  return {
    name: "excel_fill_range",
    label: "Fill Excel range",
    description: "Fill an Excel range with a scalar value or a two-dimensional matrix.",
    promptSnippet: "excel_fill_range: fill an Excel range.",
    parameters: {
      type: "object",
      properties: {
        sourcePath: { type: "string" },
        sheet: { type: "string" },
        range: { type: "string" },
        values: {},
      },
      required: ["sourcePath", "sheet", "range", "values"],
    },
    async execute(_id, params, _signal, _update, ctx) {
      const sourcePath = stringParam(params, "sourcePath");
      const sheet = stringParam(params, "sheet");
      const range = stringParam(params, "range");
      const values = (params as Record<string, unknown>)?.values;
      if (!sourcePath || !sheet || !range || values === undefined) {
        return officeError("excel_fill_range requires sourcePath, sheet, range and values.");
      }
      return runOfficeWrite(options, ctx, "xlsx", sourcePath, async (outputPath, source) => {
        const result = await fillExcelRange(source ?? new Uint8Array(), {
          kind: "excel_fill_range",
          sourcePath,
          sheet,
          range,
          values: values as never,
        });
        return { buffer: result.buffer, changedItems: result.changedItems, summary: `填充 Excel ${sheet}!${range}（${result.changedItems} 个单元格）`, outputPath };
      });
    },
  };
}

function createExcelAddSheetTool(options: OfficeRuntimeOptions): ToolDefinition<any, OfficeWriteResult | { error: string }> {
  return {
    name: "excel_add_sheet",
    label: "Add Excel worksheet",
    description: "Add a new worksheet to an Excel workbook and save an edited copy.",
    promptSnippet: "excel_add_sheet: add a worksheet to an Excel workbook.",
    parameters: {
      type: "object",
      properties: {
        sourcePath: { type: "string" },
        sheet: { type: "string" },
      },
      required: ["sourcePath", "sheet"],
    },
    async execute(_id, params, _signal, _update, ctx) {
      const sourcePath = stringParam(params, "sourcePath");
      const sheet = stringParam(params, "sheet");
      if (!sourcePath || !sheet) return officeError("excel_add_sheet requires sourcePath and sheet.");
      return runOfficeWrite(options, ctx, "xlsx", sourcePath, async (outputPath, source) => {
        const result = await addExcelSheet(source ?? new Uint8Array(), sheet);
        return { buffer: result.buffer, changedItems: 1, summary: `新增 Excel 工作表 ${sheet}`, outputPath };
      });
    },
  };
}

function createExcelFormatTool(options: OfficeRuntimeOptions): ToolDefinition<any, OfficeWriteResult | { error: string }> {
  return {
    name: "excel_format_cells",
    label: "Format Excel cells",
    description: "Apply basic number, font, fill, alignment, and wrapping styles to an Excel range.",
    promptSnippet: "excel_format_cells: format an Excel range.",
    parameters: {
      type: "object",
      properties: {
        sourcePath: { type: "string" },
        sheet: { type: "string" },
        range: { type: "string" },
        numberFormat: { type: "string" },
        bold: { type: "boolean" },
        italic: { type: "boolean" },
        fontColor: { type: "string" },
        fillColor: { type: "string" },
        horizontalAlignment: { type: "string", enum: ["left", "center", "right"] },
        verticalAlignment: { type: "string", enum: ["top", "middle", "bottom"] },
        wrapText: { type: "boolean" },
      },
      required: ["sourcePath", "sheet", "range"],
    },
    async execute(_id, params, _signal, _update, ctx) {
      const rawParams = params as Record<string, unknown>;
      const sourcePath = stringParam(params, "sourcePath");
      const sheet = stringParam(params, "sheet");
      const range = stringParam(params, "range");
      if (!sourcePath || !sheet || !range) return officeError("excel_format_cells requires sourcePath, sheet and range.");
      return runOfficeWrite(options, ctx, "xlsx", sourcePath, async (outputPath, source) => {
        const operation: ExcelFormatCellsOperation = {
          kind: "excel_format_cells",
          sourcePath,
          sheet,
          range,
          ...(stringParam(params, "numberFormat") ? { numberFormat: stringParam(params, "numberFormat") } : {}),
          ...(typeof rawParams.bold === "boolean" ? { bold: rawParams.bold } : {}),
          ...(typeof rawParams.italic === "boolean" ? { italic: rawParams.italic } : {}),
          ...(stringParam(params, "fontColor") ? { fontColor: stringParam(params, "fontColor") } : {}),
          ...(stringParam(params, "fillColor") ? { fillColor: stringParam(params, "fillColor") } : {}),
          ...(stringParam(params, "horizontalAlignment") ? { horizontalAlignment: stringParam(params, "horizontalAlignment") as ExcelFormatCellsOperation["horizontalAlignment"] } : {}),
          ...(stringParam(params, "verticalAlignment") ? { verticalAlignment: stringParam(params, "verticalAlignment") as ExcelFormatCellsOperation["verticalAlignment"] } : {}),
          ...(typeof rawParams.wrapText === "boolean" ? { wrapText: rawParams.wrapText } : {}),
        };
        const result = await formatExcelCells(source ?? new Uint8Array(), operation);
        return { buffer: result.buffer, changedItems: result.changedItems, summary: `格式化 Excel ${sheet}!${range}（${result.changedItems} 个单元格）`, outputPath };
      });
    },
  };
}

function createExcelMergeTool(options: OfficeRuntimeOptions): ToolDefinition<any, OfficeWriteResult | { error: string }> {
  return {
    name: "excel_merge_cells",
    label: "Merge Excel cells",
    description: "Merge a rectangular Excel range and save an edited copy.",
    promptSnippet: "excel_merge_cells: merge an Excel range.",
    parameters: {
      type: "object",
      properties: {
        sourcePath: { type: "string" },
        sheet: { type: "string" },
        range: { type: "string" },
      },
      required: ["sourcePath", "sheet", "range"],
    },
    async execute(_id, params, _signal, _update, ctx) {
      const sourcePath = stringParam(params, "sourcePath");
      const sheet = stringParam(params, "sheet");
      const range = stringParam(params, "range");
      if (!sourcePath || !sheet || !range) return officeError("excel_merge_cells requires sourcePath, sheet and range.");
      return runOfficeWrite(options, ctx, "xlsx", sourcePath, async (outputPath, source) => {
        const result = await mergeExcelCells(source ?? new Uint8Array(), { kind: "excel_merge_cells", sourcePath, sheet, range });
        return { buffer: result.buffer, changedItems: result.changedItems, summary: `合并 Excel ${sheet}!${range}`, outputPath };
      });
    },
  };
}

function createExcelSetColumnWidthTool(options: OfficeRuntimeOptions): ToolDefinition<any, OfficeWriteResult | { error: string }> {
  return {
    name: "excel_set_column_width",
    label: "Set Excel column width",
    description: "Set an Excel column width between 0 and 255 and save an edited copy.",
    promptSnippet: "excel_set_column_width: set an Excel column width.",
    parameters: {
      type: "object",
      properties: {
        sourcePath: { type: "string" },
        sheet: { type: "string" },
        column: { type: "string" },
        width: { type: "number" },
      },
      required: ["sourcePath", "sheet", "column", "width"],
    },
    async execute(_id, params, _signal, _update, ctx) {
      const rawParams = params as Record<string, unknown>;
      const sourcePath = stringParam(params, "sourcePath");
      const sheet = stringParam(params, "sheet");
      const column = stringParam(params, "column");
      const width = typeof rawParams.width === "number" ? rawParams.width : Number.NaN;
      if (!sourcePath || !sheet || !column || !Number.isFinite(width)) {
        return officeError("excel_set_column_width requires sourcePath, sheet, column and numeric width.");
      }
      return runOfficeWrite(options, ctx, "xlsx", sourcePath, async (outputPath, source) => {
        const result = await setExcelColumnWidth(source ?? new Uint8Array(), { kind: "excel_set_column_width", sourcePath, sheet, column, width });
        return { buffer: result.buffer, changedItems: result.changedItems, summary: `设置 Excel ${sheet}!${column} 列宽为 ${width}`, outputPath };
      });
    },
  };
}

async function runOfficeWrite(
  options: OfficeRuntimeOptions,
  ctx: ExtensionContext,
  format: OfficeFormat,
  sourcePath: string | undefined,
  build: (outputPath: string, source?: Uint8Array) => Promise<{ buffer: Uint8Array; changedItems: number; summary: string; outputPath: string }>,
): Promise<AgentToolResult<OfficeWriteResult | { error: string }>> {
  try {
    options.assertAllowed?.();
    if (options.getPermissionMode?.(ctx) === "plan") return officeError("办公写入在 plan 权限模式下被阻止，请切换到 auto 后重试。");
    const scope = options.getScope(ctx);
    let source: Uint8Array | undefined;
    let outputPath: string;
    if (sourcePath) {
      await validateSourcePath(sourcePath, format, scope);
      source = new Uint8Array(await readFile(sourcePath));
      outputPath = await chooseEditedOutputPath(sourcePath);
    } else {
      outputPath = (await options.chooseNewFilePath(format)) ?? "";
      if (!outputPath) return officeError("已取消保存位置选择，未写入文件。");
      outputPath = validateOutputPath(outputPath, format);
      await ensureTargetDoesNotExist(outputPath);
    }
    const prepared = await build(outputPath, source);
    const confirmed = options.confirmWrite
      ? await options.confirmWrite(ctx, prepared.summary, prepared.outputPath, prepared.changedItems)
      : ctx.hasUI && await ctx.ui.confirm("确认办公文件写入", `${prepared.summary}\n输出：${prepared.outputPath}\n变更项：${prepared.changedItems}`);
    if (!confirmed) return officeError("用户取消了办公文件写入，未产生文件。");
    await atomicOfficeWrite(prepared.outputPath, prepared.buffer, format);
    const result: OfficeWriteResult = {
      format,
      ...(sourcePath ? { sourcePath } : {}),
      outputPath: prepared.outputPath,
      summary: prepared.summary,
      changedItems: prepared.changedItems,
    };
    await options.onWriteComplete?.(result);
    return {
      content: [{ type: "text", text: `${prepared.summary}\n已另存为：${prepared.outputPath}` }],
      details: result,
    };
  } catch (error) {
    return officeError(toolErrorMessage(error));
  }
}

async function chooseEditedOutputPath(sourcePath: string): Promise<string> {
  const directory = path.dirname(sourcePath);
  const base = path.basename(sourcePath);
  const extension = path.extname(base);
  const stem = base.slice(0, -extension.length);
  let candidate = path.join(directory, `${stem}.edited${extension}`);
  let index = 2;
  while (await exists(candidate)) {
    candidate = path.join(directory, `${stem}.edited-${index}${extension}`);
    index += 1;
  }
  return candidate;
}

export type OfficeFileIO = Pick<typeof import("node:fs/promises"), "open" | "readFile" | "link" | "unlink" | "lstat">;
const officeFileIO: OfficeFileIO = { open, readFile, link, unlink, lstat };

export async function atomicOfficeWrite(
  outputPath: string,
  buffer: Uint8Array,
  format: OfficeFormat,
  io: OfficeFileIO = officeFileIO,
): Promise<void> {
  // A bounded temp name: appending to the full output name can overflow the
  // 255-character limit on a single path component for a long Chinese filename.
  const tempPath = path.join(path.dirname(outputPath), `.${path.basename(outputPath).slice(0, 24)}.${randomUUID()}.tmp`);
  try {
    const handle = await io.open(tempPath, "wx");
    try {
      await handle.writeFile(buffer);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await validateOfficeBuffer(new Uint8Array(await io.readFile(tempPath)), format);
    await publishOfficeFile(tempPath, outputPath, buffer, io);
  } catch (error) {
    await io.unlink(tempPath).catch(() => undefined);
    throw error;
  }
  // The save is already complete and validated at this point. A temp file we
  // cannot delete (an antivirus scanner still holding it, say) is housekeeping,
  // not a failed write, so it must not turn a saved document into an error.
  await io.unlink(tempPath).catch((error) => {
    console.warn(`[office-runtime] left a temp file behind at ${tempPath}`, error);
  });
}

/**
 * Publish the validated temp file as `outputPath` without ever overwriting an
 * existing file — the target may have appeared while the confirmation dialog was
 * open.
 *
 * A hard link is the first choice: it is atomic and it fails outright if the
 * target exists. exFAT and FAT32 have no hard links at all (nor do most network
 * shares), and on those volumes the whole save used to fail at the last step
 * with the document already generated. The fallback creates the output with an
 * exclusive open instead, which keeps the no-overwrite guarantee; it is not
 * atomic in its contents. On failure, cleanup removes only the same file we
 * exclusively opened; a competing process may have replaced the path meanwhile.
 */
export async function publishOfficeFile(
  tempPath: string,
  outputPath: string,
  buffer: Uint8Array,
  io: OfficeFileIO = officeFileIO,
): Promise<void> {
  try {
    await io.link(tempPath, outputPath);
    return;
  } catch (error) {
    if (isExistingTargetError(error)) {
      throw new Error("目标文件在保存前已被创建，为避免覆盖已取消写入。");
    }
    if (!isUnsupportedLinkError(error)) {
      throw error;
    }
  }

  const handle = await openExclusive(outputPath, io);
  let identity: Awaited<ReturnType<typeof handle.stat>> | undefined;
  let writeError: unknown;
  try {
    identity = await handle.stat();
    await handle.writeFile(buffer);
    await handle.sync();
  } catch (error) {
    writeError = error;
  } finally {
    await handle.close().catch((error) => { writeError ??= error; });
  }
  if (writeError) {
    try {
      const current = await io.lstat(outputPath);
      if (identity && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino) {
        await io.unlink(outputPath);
      }
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        throw new Error(`保存失败，未能清理不完整文件：${outputPath}`, { cause: writeError });
      }
    }
    throw writeError;
  }
}

async function openExclusive(outputPath: string, io: OfficeFileIO): Promise<Awaited<ReturnType<typeof open>>> {
  try {
    return await io.open(outputPath, "wx");
  } catch (error) {
    if (isExistingTargetError(error)) {
      throw new Error("目标文件在保存前已被创建，为避免覆盖已取消写入。");
    }
    throw error;
  }
}

function isExistingTargetError(error: unknown): boolean {
  return errorCode(error) === "EEXIST";
}

/** Filesystems without hard links report this in several shapes across platforms. */
function isUnsupportedLinkError(error: unknown): boolean {
  const code = errorCode(error);
  return (
    code === "EPERM" ||
    code === "EACCES" ||
    code === "ENOSYS" ||
    code === "ENOTSUP" ||
    code === "EOPNOTSUPP" ||
    code === "EXDEV" ||
    code === "EINVAL" ||
    code === "EMLINK"
  );
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

async function validateOfficeBuffer(buffer: Uint8Array, format: OfficeFormat): Promise<void> {
  if (buffer.byteLength === 0 || buffer.byteLength > MAX_OFFICE_BYTES) throw new Error("办公文件为空或超过大小限制。");
  const files = unzipSync(buffer);
  const required = format === "docx" ? "word/document.xml" : "xl/workbook.xml";
  if (!files[required]) throw new Error(`生成的 ${format} 文件校验失败。`);
  if (format === "docx" && !readZipText(files, required).includes("<w:document")) throw new Error("生成的 Word 文档结构无效。");
  if (format === "xlsx") {
    await loadWorkbook(buffer);
  }
}

async function validateSourcePath(sourcePath: string, format: OfficeFormat, scope: OfficeAccessScope): Promise<void> {
  if (!isOfficePathInScope(sourcePath, scope)) throw new Error("源文件不在当前工作区或会话附件范围内。");
  const extension = path.extname(sourcePath).toLowerCase();
  if (extension !== `.${format}`) throw new Error(`源文件扩展名必须是 .${format}。`);
  const info = await stat(sourcePath);
  if (!info.isFile() || info.size > MAX_OFFICE_BYTES) throw new Error("源文件不存在、不是普通文件或超过大小限制。");
  if ((await lstat(sourcePath)).isSymbolicLink()) throw new Error("拒绝通过符号链接修改办公文件。");
  const real = await realpath(sourcePath);
  const realRoots = await Promise.all(scope.workspaceRoots.map((root) => realpath(root).catch(() => path.resolve(root))));
  const realAllowedFiles = await Promise.all(scope.allowedFiles.map((file) => realpath(file).catch(() => path.resolve(file))));
  const realReadOnlyRoots = await Promise.all(
    (scope.readOnlyRoots ?? []).map((root) => realpath(root).catch(() => path.resolve(root))),
  );
  if (!isOfficePathInScope(real, {
    workspaceRoots: realRoots,
    allowedFiles: realAllowedFiles,
    readOnlyRoots: realReadOnlyRoots,
  })) {
    throw new Error("源文件真实路径不在当前工作区或会话附件范围内。");
  }
}

function validateOutputPath(outputPath: string, format: OfficeFormat): string {
  const resolved = path.resolve(outputPath);
  if (path.extname(resolved).toLowerCase() !== `.${format}`) throw new Error(`输出文件扩展名必须是 .${format}。`);
  return resolved;
}

async function ensureTargetDoesNotExist(target: string): Promise<void> {
  if (await exists(target)) throw new Error("目标文件已存在，为避免覆盖原文件请另选一个新文件名。");
}

async function loadWorkbook(buffer: Uint8Array): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as never);
  return workbook;
}

function normalizeExcelValue(value: unknown): ExcelJS.CellValue {
  if (typeof value === "object" && value !== null && "formula" in value && typeof (value as { formula?: unknown }).formula === "string") {
    const result = (value as { result?: unknown }).result;
    return { formula: (value as { formula: string }).formula, ...(typeof result === "number" || typeof result === "string" ? { result } : {}) };
  }
  // `null` and a missing value both mean "empty cell"; stringifying the latter
  // would write the literal text "undefined" into the sheet.
  if (value === undefined) return null;
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return String(value);
}

function normalizeExcelColor(value: string): string {
  const normalized = value.trim().replace(/^#/, "").toUpperCase();
  if (!/^[0-9A-F]{6}([0-9A-F]{2})?$/.test(normalized)) {
    throw new Error(`非法 Excel 颜色：${value}`);
  }
  return normalized.length === 6 ? `FF${normalized}` : normalized;
}

function parseRange(value: string): { startRow: number; startColumn: number; width: number; height: number } {
  const match = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/i.exec(value.trim());
  if (!match) throw new Error(`非法 Excel 范围：${value}`);
  const startColumn = columnNumber(match[1] as string);
  const startRow = Number.parseInt(match[2] as string, 10);
  const endColumn = match[3] ? columnNumber(match[3]) : startColumn;
  const endRow = match[4] ? Number.parseInt(match[4], 10) : startRow;
  if (endColumn < startColumn || endRow < startRow) throw new Error(`非法 Excel 范围：${value}`);
  return { startRow, startColumn, width: endColumn - startColumn + 1, height: endRow - startRow + 1 };
}

function columnNumber(value: string): number {
  let result = 0;
  for (const char of value.toUpperCase()) result = result * 26 + char.charCodeAt(0) - 64;
  return result;
}

function safeSheetName(value: string): string {
  const normalized = value.trim().replace(/[\\/?*\[\]:]/g, "-").slice(0, 31);
  return normalized || "Sheet1";
}

function arrayRowsParam(params: unknown, key: string): readonly (readonly unknown[])[] {
  const value = typeof params === "object" && params !== null ? (params as Record<string, unknown>)[key] : undefined;
  return Array.isArray(value) ? value.filter(Array.isArray) as readonly (readonly unknown[])[] : [];
}

function stringArrayParam(params: unknown, key: string): readonly string[] {
  const value = typeof params === "object" && params !== null ? (params as Record<string, unknown>)[key] : undefined;
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function recordParam(params: unknown, key: string): Readonly<Record<string, unknown>> | undefined {
  const value = typeof params === "object" && params !== null ? (params as Record<string, unknown>)[key] : undefined;
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function officeError(error: string): AgentToolResult<{ error: string }> {
  return { content: [{ type: "text", text: error }], details: { error } };
}

function wordAppendXml(operation: Pick<WordAppendOperation, "contentType" | "headingLevel" | "text" | "items" | "rows">): string {
  if (operation.contentType === "heading") return wordParagraph(operation.text ?? "", `Heading${operation.headingLevel ?? 1}`);
  if (operation.contentType === "paragraph") return wordParagraph(operation.text ?? "");
  if (operation.contentType === "list") return (operation.items ?? []).map((item) => wordListParagraph(item)).join("");
  if (operation.contentType === "table") {
    const rows = operation.rows ?? [];
    if (rows.length === 0) return "";
    return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>${rows.map((row) => `<w:tr>${row.map((cell) => `<w:tc><w:p><w:r><w:t xml:space="preserve">${escapeXml(String(cell))}</w:t></w:r></w:p></w:tc>`).join("")}</w:tr>`).join("")}</w:tbl>`;
  }
  return "";
}

function wordParagraph(text: string, style?: string): string {
  const property = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : "";
  return `<w:p>${property}<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

function wordListParagraph(text: string): string {
  return `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

function documentXml(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
}

function wordPackage(document: string): Record<string, Uint8Array> {
  const encoder = new TextEncoder();
  return {
    "[Content_Types].xml": encoder.encode(`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>`),
    "_rels/.rels": encoder.encode(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`),
    "word/_rels/document.xml.rels": encoder.encode(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>`),
    "word/document.xml": encoder.encode(document),
    "word/numbering.xml": encoder.encode(numberingXml()),
  };
}

function ensureWordNumbering(files: Record<string, Uint8Array>): void {
  const encoder = new TextEncoder();
  if (!files["word/numbering.xml"]) files["word/numbering.xml"] = encoder.encode(numberingXml());
  const relationshipPath = "word/_rels/document.xml.rels";
  const numberingRelationship = "Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering\"";
  if (!files[relationshipPath]) {
    files[relationshipPath] = encoder.encode(
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" ${numberingRelationship} Target="numbering.xml"/></Relationships>`,
    );
  } else {
    const relationships = readZipText(files, relationshipPath);
    if (!relationships.includes(numberingRelationship)) {
      const ids = [...relationships.matchAll(/\bId="rId(\d+)"/g)].map((match) => Number(match[1]));
      const nextId = Math.max(0, ...ids) + 1;
      files[relationshipPath] = encoder.encode(
        relationships.replace(
          "</Relationships>",
          `<Relationship Id="rId${nextId}" ${numberingRelationship} Target="numbering.xml"/></Relationships>`,
        ),
      );
    }
  }
  const contentTypes = readZipText(files, "[Content_Types].xml");
  if (!contentTypes.includes("/word/numbering.xml")) {
    files["[Content_Types].xml"] = encoder.encode(
      contentTypes.replace("</Types>", '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>'),
    );
  }
}

function numberingXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="-"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;
}

function readZipText(files: Record<string, Uint8Array>, file: string): string {
  const value = files[file];
  if (!value) throw new Error(`文档缺少 ${file}。`);
  return new TextDecoder("utf-8").decode(value);
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&apos;");
}

async function exists(filePath: string): Promise<boolean> {
  try { await stat(filePath); return true; } catch { return false; }
}
