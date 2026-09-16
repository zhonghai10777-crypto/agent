/**
 * Structured document contract for the office generation/editing pipeline.
 *
 * This is an application-level contract (see Task Order §6), not a
 * third-party API. It is the only shape the model is allowed to submit for
 * "create a Word document" work: no raw OOXML, no arbitrary HTML/JS, no
 * template expression evaluation. `validateDocumentSpec` enforces every
 * bound described in the spec (§6.1) and returns a typed, located error
 * list instead of throwing on the first problem, so the caller can report
 * every violation at once.
 */

export type Locale = "zh-CN" | "en-US";

export interface TextInline {
  readonly type: "text";
  readonly text: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
}
export interface LineBreakInline {
  readonly type: "lineBreak";
}
export interface LinkInline {
  readonly type: "link";
  readonly text: string;
  readonly href: string;
}
export type Inline = TextInline | LineBreakInline | LinkInline;

export interface HeadingBlock {
  readonly id: string;
  readonly type: "heading";
  readonly level: 1 | 2 | 3;
  readonly content: readonly Inline[];
}
export interface ParagraphBlock {
  readonly id: string;
  readonly type: "paragraph";
  readonly content: readonly Inline[];
  readonly role?: "body" | "note";
}
export interface ListBlock {
  readonly id: string;
  readonly type: "list";
  readonly ordered: boolean;
  readonly items: readonly (readonly Inline[])[];
}
export interface TableColumn {
  readonly key: string;
  readonly title: string;
  readonly widthWeight: number;
}
export interface TableRow {
  readonly cells: readonly { readonly content: readonly Inline[] }[];
}
export interface TableBlock {
  readonly id: string;
  readonly type: "table";
  readonly columns: readonly TableColumn[];
  readonly rows: readonly TableRow[];
  readonly headerRows: 1;
  readonly styleId: string;
  readonly layout?: "auto" | "landscape";
}
export interface ImageBlock {
  readonly id: string;
  readonly type: "image";
  readonly assetId: string;
  readonly alt: string;
  readonly caption?: string;
}
export interface PageBreakBlock {
  readonly id: string;
  readonly type: "pageBreak";
}
export type Block = HeadingBlock | ParagraphBlock | ListBlock | TableBlock | ImageBlock | PageBreakBlock;

export interface DocumentSpec {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly title: string;
  readonly locale: Locale;
  readonly styleProfileId: string;
  readonly blocks: readonly Block[];
  readonly header?: readonly Inline[];
  readonly footer?: readonly Inline[];
  readonly pageNumbers?: boolean;
}

/** Registered, host-authorized image asset. The model submits only an `assetId`. */
export interface RegisteredImageAsset {
  readonly assetId: string;
  readonly buffer: Uint8Array;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly mimeType: "image/png" | "image/jpeg";
}

export interface SpecValidationError {
  readonly path: string;
  readonly message: string;
}
export interface SpecValidationResult {
  readonly valid: boolean;
  readonly errors: readonly SpecValidationError[];
}

// §15 resource budgets (defaults; overridable by host configuration, never silently).
export const MAX_SPEC_CHARACTERS = 500_000;
export const MAX_BLOCKS = 20_000;
export const MAX_TABLE_ROWS = 5_000;
export const MAX_TABLE_COLUMNS = 64;
export const MAX_LIST_ITEMS = 5_000;
export const MAX_NODE_DEPTH = 8; // inline arrays are flat, but keeps a documented ceiling for future nesting.

const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

export function validateDocumentSpec(
  spec: unknown,
  options: { readonly knownStyleProfileIds: readonly string[]; readonly knownAssetIds?: readonly string[] },
): SpecValidationResult {
  const errors: SpecValidationError[] = [];
  const push = (path: string, message: string) => errors.push({ path, message });

  if (typeof spec !== "object" || spec === null) {
    return { valid: false, errors: [{ path: "$", message: "DocumentSpec 必须是对象。" }] };
  }
  const s = spec as Record<string, unknown>;

  if (s.schemaVersion !== 1) push("$.schemaVersion", "schemaVersion 必须为 1。");
  if (typeof s.requestId !== "string" || !ID_PATTERN.test(s.requestId)) {
    push("$.requestId", "requestId 必须是非空的受限字符串（字母、数字、._: -，最长 128）。");
  }
  if (typeof s.title !== "string" || s.title.trim().length === 0) {
    push("$.title", "title 不能为空。");
  }
  if (s.locale !== "zh-CN" && s.locale !== "en-US") {
    push("$.locale", "locale 必须是 zh-CN 或 en-US。");
  }
  if (typeof s.styleProfileId !== "string" || !options.knownStyleProfileIds.includes(s.styleProfileId)) {
    push(
      "$.styleProfileId",
      `styleProfileId 必须是已知样式方案之一：${options.knownStyleProfileIds.join(", ")}。`,
    );
  }
  if (s.pageNumbers !== undefined && typeof s.pageNumbers !== "boolean") {
    push("$.pageNumbers", "pageNumbers 必须是布尔值。");
  }

  const seenIds = new Set<string>();
  let totalChars = 0;

  const validateInline = (inline: unknown, path: string): number => {
    if (typeof inline !== "object" || inline === null) {
      push(path, "inline 节点必须是对象。");
      return 0;
    }
    const node = inline as Record<string, unknown>;
    if (node.type === "text") {
      if (typeof node.text !== "string") {
        push(`${path}.text`, "text inline 缺少字符串 text。");
        return 0;
      }
      if (node.bold !== undefined && typeof node.bold !== "boolean") push(`${path}.bold`, "bold 必须是布尔值。");
      if (node.italic !== undefined && typeof node.italic !== "boolean") push(`${path}.italic`, "italic 必须是布尔值。");
      return node.text.length;
    }
    if (node.type === "lineBreak") return 0;
    if (node.type === "link") {
      if (typeof node.text !== "string" || node.text.length === 0) push(`${path}.text`, "link 缺少显示文本。");
      if (typeof node.href !== "string" || !/^https?:\/\//i.test(node.href)) {
        push(`${path}.href`, "link 的 href 必须是 http(s) 链接。");
      }
      return typeof node.text === "string" ? node.text.length : 0;
    }
    push(`${path}.type`, `不支持的 inline 类型：${String(node.type)}。`);
    return 0;
  };

  const validateInlineArray = (value: unknown, path: string): number => {
    if (!Array.isArray(value)) {
      push(path, "内容必须是 inline 数组。");
      return 0;
    }
    let chars = 0;
    value.forEach((inline, index) => {
      chars += validateInline(inline, `${path}[${index}]`);
    });
    return chars;
  };

  const checkId = (id: unknown, path: string): void => {
    if (typeof id !== "string" || !ID_PATTERN.test(id)) {
      push(path, "block id 必须是受限字符串（字母、数字、._: -，最长 128）。");
      return;
    }
    if (seenIds.has(id)) {
      push(path, `重复的 block id：${id}`);
      return;
    }
    seenIds.add(id);
  };

  const blocks = s.blocks;
  if (!Array.isArray(blocks)) {
    push("$.blocks", "blocks 必须是数组。");
  } else {
    if (blocks.length === 0) push("$.blocks", "blocks 不能为空。");
    if (blocks.length > MAX_BLOCKS) push("$.blocks", `blocks 数量超过上限 ${MAX_BLOCKS}。`);
    blocks.forEach((block, index) => {
      const path = `$.blocks[${index}]`;
      if (typeof block !== "object" || block === null) {
        push(path, "block 必须是对象。");
        return;
      }
      const b = block as Record<string, unknown>;
      checkId(b.id, `${path}.id`);
      switch (b.type) {
        case "heading": {
          if (![1, 2, 3].includes(b.level as number)) push(`${path}.level`, "heading level 必须是 1、2 或 3。");
          totalChars += validateInlineArray(b.content, `${path}.content`);
          break;
        }
        case "paragraph": {
          if (b.role !== undefined && b.role !== "body" && b.role !== "note") {
            push(`${path}.role`, "role 必须是 body 或 note。");
          }
          totalChars += validateInlineArray(b.content, `${path}.content`);
          break;
        }
        case "list": {
          if (typeof b.ordered !== "boolean") push(`${path}.ordered`, "ordered 必须是布尔值。");
          if (!Array.isArray(b.items)) {
            push(`${path}.items`, "items 必须是数组。");
          } else {
            if (b.items.length === 0) push(`${path}.items`, "items 不能为空。");
            if (b.items.length > MAX_LIST_ITEMS) push(`${path}.items`, `items 数量超过上限 ${MAX_LIST_ITEMS}。`);
            b.items.forEach((item, itemIndex) => {
              totalChars += validateInlineArray(item, `${path}.items[${itemIndex}]`);
            });
          }
          break;
        }
        case "table": {
          totalChars += validateTable(b, path, push);
          break;
        }
        case "image": {
          if (typeof b.assetId !== "string" || b.assetId.length === 0) push(`${path}.assetId`, "image 缺少 assetId。");
          else if (options.knownAssetIds && !options.knownAssetIds.includes(b.assetId)) {
            push(`${path}.assetId`, `assetId 未在本会话登记授权：${b.assetId}`);
          }
          if (typeof b.alt !== "string" || b.alt.length === 0) push(`${path}.alt`, "image 缺少 alt 文本。");
          if (b.caption !== undefined && typeof b.caption !== "string") push(`${path}.caption`, "caption 必须是字符串。");
          break;
        }
        case "pageBreak":
          break;
        default:
          push(`${path}.type`, `不支持的 block 类型：${String(b.type)}。`);
      }
    });
  }

  if (s.header !== undefined) totalChars += validateInlineArray(s.header, "$.header");
  if (s.footer !== undefined) totalChars += validateInlineArray(s.footer, "$.footer");

  if (totalChars > MAX_SPEC_CHARACTERS) {
    push("$", `正文总字符数 ${totalChars} 超过上限 ${MAX_SPEC_CHARACTERS}，请拆分文档而不是截断内容。`);
  }

  return { valid: errors.length === 0, errors };
}

function validateTable(
  b: Record<string, unknown>,
  path: string,
  push: (path: string, message: string) => void,
): number {
  let chars = 0;
  if (b.headerRows !== 1) push(`${path}.headerRows`, "headerRows 目前只支持 1。");
  if (typeof b.styleId !== "string" || b.styleId.length === 0) push(`${path}.styleId`, "table 缺少 styleId。");
  if (b.layout !== undefined && b.layout !== "auto" && b.layout !== "landscape") {
    push(`${path}.layout`, "layout 必须是 auto 或 landscape。");
  }
  const columns = b.columns;
  let columnCount = 0;
  if (!Array.isArray(columns) || columns.length === 0) {
    push(`${path}.columns`, "columns 不能为空。");
  } else {
    columnCount = columns.length;
    if (columnCount > MAX_TABLE_COLUMNS) push(`${path}.columns`, `列数超过上限 ${MAX_TABLE_COLUMNS}。`);
    columns.forEach((column, columnIndex) => {
      const colPath = `${path}.columns[${columnIndex}]`;
      if (typeof column !== "object" || column === null) {
        push(colPath, "column 必须是对象。");
        return;
      }
      const c = column as Record<string, unknown>;
      if (typeof c.key !== "string" || c.key.length === 0) push(`${colPath}.key`, "column 缺少 key。");
      if (typeof c.title !== "string") push(`${colPath}.title`, "column 缺少 title。");
      const weight = c.widthWeight;
      if (typeof weight !== "number" || !Number.isFinite(weight) || weight <= 0) {
        push(`${colPath}.widthWeight`, "widthWeight 必须是正的有限数值（拒绝 0、负数、NaN、Infinity）。");
      }
    });
  }
  const rows = b.rows;
  if (!Array.isArray(rows)) {
    push(`${path}.rows`, "rows 必须是数组。");
  } else {
    if (rows.length > MAX_TABLE_ROWS) push(`${path}.rows`, `行数超过上限 ${MAX_TABLE_ROWS}。`);
    rows.forEach((row, rowIndex) => {
      const rowPath = `${path}.rows[${rowIndex}]`;
      if (typeof row !== "object" || row === null || !Array.isArray((row as Record<string, unknown>).cells)) {
        push(rowPath, "row 必须包含 cells 数组。");
        return;
      }
      const cells = (row as Record<string, unknown>).cells as unknown[];
      if (columnCount > 0 && cells.length !== columnCount) {
        push(rowPath, `行的单元格数量 ${cells.length} 与列定义数量 ${columnCount} 不一致。`);
      }
      cells.forEach((cell, cellIndex) => {
        if (typeof cell !== "object" || cell === null) {
          push(`${rowPath}.cells[${cellIndex}]`, "cell 必须是对象。");
          return;
        }
        const content = (cell as Record<string, unknown>).content;
        if (!Array.isArray(content)) {
          push(`${rowPath}.cells[${cellIndex}].content`, "cell 缺少 content 数组。");
          return;
        }
        for (const inline of content) {
          if (typeof inline === "object" && inline !== null && (inline as Record<string, unknown>).type === "text") {
            const text = (inline as Record<string, unknown>).text;
            if (typeof text === "string") chars += text.length;
          }
        }
      });
    });
  }
  return chars;
}

/** Resolve per-column pixel/twip widths from `widthWeight`, rounding the remainder into the last column so widths never silently overflow the table's total width. */
export function resolveColumnWidths(columns: readonly TableColumn[], totalWidthTwips: number): number[] {
  const totalWeight = columns.reduce((sum, column) => sum + column.widthWeight, 0);
  if (totalWeight <= 0) throw new Error("表格列宽权重之和必须为正数。");
  const widths = columns.map((column) => Math.floor((column.widthWeight / totalWeight) * totalWidthTwips));
  const used = widths.reduce((sum, width) => sum + width, 0);
  const remainder = totalWidthTwips - used;
  widths[widths.length - 1] = (widths[widths.length - 1] ?? 0) + remainder;
  return widths;
}
