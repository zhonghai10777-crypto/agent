import { unzipSync } from "fflate";

/**
 * Minimal read-only XLSX reader.
 *
 * The write path uses ExcelJS, but reads stay on this small OOXML parser: it is
 * faster for attachment extraction and keeps the model-facing representation
 * deliberately limited to sheet names and cell text.
 *
 * Scope is deliberately "what the model needs to read": sheet names, cell text,
 * and dates rendered as dates rather than raw serial numbers. Formatting,
 * formulas, charts and images are out of scope.
 */

export interface XlsxSheet {
  readonly name: string;
  readonly rows: readonly (readonly string[])[];
}

export interface XlsxWorkbook {
  readonly sheets: readonly XlsxSheet[];
}

/** Built-in numFmt ids that Excel reserves for dates and times. */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/** OOXML parts are UTF-8 by spec, so no encoding detection is needed here. */
function textPart(files: Record<string, Uint8Array>, name: string): string | undefined {
  const part = files[name];
  return part ? new TextDecoder("utf-8").decode(part) : undefined;
}

export function readXlsx(buffer: Uint8Array): XlsxWorkbook {
  const files = unzipSync(buffer);
  const workbookXml = textPart(files, "xl/workbook.xml");
  if (!workbookXml) {
    throw new Error("not an xlsx workbook (missing xl/workbook.xml)");
  }

  const relationships = readRelationships(textPart(files, "xl/_rels/workbook.xml.rels") ?? "");
  const sharedStrings = readSharedStrings(textPart(files, "xl/sharedStrings.xml") ?? "");
  const dateStyles = readDateStyles(textPart(files, "xl/styles.xml") ?? "");

  const sheets: XlsxSheet[] = [];
  for (const [index, element] of [...workbookXml.matchAll(/<sheet\b[^>]*\/?>/g)].entries()) {
    const tag = element[0];
    const name = decodeXmlEntities(attribute(tag, "name") ?? `Sheet${index + 1}`);
    const relationshipId = attribute(tag, "r:id") ?? attribute(tag, "relationshipId");
    const target = relationshipId ? relationships.get(relationshipId) : undefined;
    // Fall back to positional naming for the rare workbook without usable rels.
    const partName = target ? normalizePart(target) : `xl/worksheets/sheet${index + 1}.xml`;
    const sheetXml = textPart(files, partName);
    if (sheetXml === undefined) {
      continue;
    }
    sheets.push({ name, rows: readSheetRows(sheetXml, sharedStrings, dateStyles) });
  }

  if (sheets.length === 0) {
    throw new Error("workbook contains no readable worksheets");
  }
  return { sheets };
}

function readSheetRows(
  sheetXml: string,
  sharedStrings: readonly string[],
  dateStyles: ReadonlySet<number>,
): readonly (readonly string[])[] {
  const rows: string[][] = [];
  for (const rowMatch of sheetXml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>|<row\b[^>]*\/>/g)) {
    const body = rowMatch[1] ?? "";
    const cells: string[] = [];
    for (const cellMatch of body.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g)) {
      const attributes = cellMatch[1] ?? cellMatch[3] ?? "";
      const content = cellMatch[2] ?? "";
      const reference = attribute(`<c ${attributes}>`, "r");
      const column = reference ? columnIndex(reference) : cells.length;
      // Sparse rows must keep their column alignment or a table's headers stop
      // lining up with its values.
      while (cells.length < column) {
        cells.push("");
      }
      cells[column] = cellValue(attributes, content, sharedStrings, dateStyles);
    }
    while (cells.length > 0 && cells[cells.length - 1] === "") {
      cells.pop();
    }
    if (cells.length > 0) {
      rows.push(cells);
    }
  }
  return rows;
}

function cellValue(
  attributes: string,
  content: string,
  sharedStrings: readonly string[],
  dateStyles: ReadonlySet<number>,
): string {
  const tag = `<c ${attributes}>`;
  const type = attribute(tag, "t");

  if (type === "s") {
    const index = Number.parseInt(innerText(content, "v") ?? "", 10);
    return Number.isInteger(index) ? (sharedStrings[index] ?? "") : "";
  }
  if (type === "inlineStr") {
    return collectTextNodes(content);
  }
  if (type === "b") {
    return innerText(content, "v") === "1" ? "TRUE" : "FALSE";
  }
  if (type === "e") {
    return innerText(content, "v") ?? "";
  }

  const raw = innerText(content, "v") ?? (type === "str" ? collectTextNodes(content) : undefined);
  if (raw === undefined || raw === "") {
    return "";
  }

  const styleIndex = Number.parseInt(attribute(tag, "s") ?? "", 10);
  if (Number.isInteger(styleIndex) && dateStyles.has(styleIndex)) {
    const formatted = excelSerialToDate(Number(raw));
    if (formatted) {
      return formatted;
    }
  }
  return decodeXmlEntities(raw);
}

/**
 * Excel stores dates as days since 1899-12-30 (the offset absorbs the
 * deliberate 1900-leap-year bug). Left as a raw serial, a defect log's dates
 * reach the model as five-digit numbers it will happily reason about as
 * quantities.
 */
function excelSerialToDate(serial: number): string | undefined {
  if (!Number.isFinite(serial) || serial <= 0) {
    return undefined;
  }
  const epoch = Date.UTC(1899, 11, 30);
  const date = new Date(epoch + Math.round(serial * 86_400_000));
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  const iso = date.toISOString();
  // Whole-day values carry no meaningful time component.
  return serial % 1 === 0 ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
}

function readSharedStrings(xml: string): readonly string[] {
  const strings: string[] = [];
  for (const match of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)) {
    strings.push(collectTextNodes(match[1] ?? ""));
  }
  return strings;
}

/**
 * Maps a cell's style index to whether that style renders as a date, via
 * cellXfs → numFmtId, checking both Excel's built-in ids and custom formats.
 */
function readDateStyles(xml: string): ReadonlySet<number> {
  const customDateFormats = new Set<number>();
  for (const match of xml.matchAll(/<numFmt\b[^>]*\/>/g)) {
    const id = Number.parseInt(attribute(match[0], "numFmtId") ?? "", 10);
    const code = attribute(match[0], "formatCode") ?? "";
    // A format is a date format when it positions date tokens outside of any
    // literal quoted text; y/m/d/h/s cover every such token.
    const withoutLiterals = code.replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, "");
    if (Number.isInteger(id) && /[ymdhs]/i.test(withoutLiterals)) {
      customDateFormats.add(id);
    }
  }

  const cellXfsBlock = xml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] ?? "";
  const dateStyles = new Set<number>();
  for (const [index, match] of [...cellXfsBlock.matchAll(/<xf\b[^>]*\/?>/g)].entries()) {
    const numFmtId = Number.parseInt(attribute(match[0], "numFmtId") ?? "", 10);
    if (Number.isInteger(numFmtId) && (BUILTIN_DATE_FORMATS.has(numFmtId) || customDateFormats.has(numFmtId))) {
      dateStyles.add(index);
    }
  }
  return dateStyles;
}

function readRelationships(xml: string): ReadonlyMap<string, string> {
  const relationships = new Map<string, string>();
  for (const match of xml.matchAll(/<Relationship\b[^>]*\/?>/g)) {
    const id = attribute(match[0], "Id");
    const target = attribute(match[0], "Target");
    if (id && target) {
      relationships.set(id, target);
    }
  }
  return relationships;
}

/** Concatenates every `<t>` node, which is how rich-text runs stay readable. */
function collectTextNodes(xml: string): string {
  let text = "";
  for (const match of xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) {
    text += match[1] ?? "";
  }
  return decodeXmlEntities(text);
}

/**
 * Both of these run per cell, so a 20k-cell sheet would otherwise compile
 * ~40k identical regexes. The pattern set is tiny and fixed (a handful of tag
 * and attribute names), so caching by name makes it a map lookup instead.
 */
const innerTextPatterns = new Map<string, RegExp>();
const attributePatterns = new Map<string, RegExp>();

function innerText(xml: string, tagName: string): string | undefined {
  let pattern = innerTextPatterns.get(tagName);
  if (!pattern) {
    pattern = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)</${tagName}>`);
    innerTextPatterns.set(tagName, pattern);
  }
  return xml.match(pattern)?.[1];
}

function attribute(tag: string, name: string): string | undefined {
  let pattern = attributePatterns.get(name);
  if (!pattern) {
    pattern = new RegExp(`\\b${name.replace(":", "\\:")}="([^"]*)"`);
    attributePatterns.set(name, pattern);
  }
  return tag.match(pattern)?.[1];
}

function columnIndex(reference: string): number {
  const letters = reference.match(/^[A-Z]+/i)?.[0] ?? "";
  let index = 0;
  for (const letter of letters.toUpperCase()) {
    index = index * 26 + (letter.charCodeAt(0) - 64);
  }
  return Math.max(0, index - 1);
}

function normalizePart(target: string): string {
  const cleaned = target.replace(/^\/+/, "").replace(/^xl\//, "");
  return `xl/${cleaned}`;
}

function decodeXmlEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (entity, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      return codePoint(Number.parseInt(body.slice(2), 16)) ?? entity;
    }
    if (body.startsWith("#")) {
      return codePoint(Number.parseInt(body.slice(1), 10)) ?? entity;
    }
    switch (body) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default:
        return entity;
    }
  });
}

function codePoint(value: number): string | undefined {
  return Number.isFinite(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : undefined;
}
