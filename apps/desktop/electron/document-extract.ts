import path from "node:path";
import { readXlsx, type XlsxWorkbook } from "./xlsx-reader";
import { MAX_DOCUMENT_BYTES, MAX_EXTRACTED_CHARS, MAX_DOCUMENT_CHARS } from "./document-limits";
import { DocumentZipError, inspectDocumentZip, readDocumentZipParts } from "./document-zip";
export { MAX_DOCUMENT_BYTES, MAX_EXTRACTED_CHARS, MAX_DOCUMENT_CHARS } from "./document-limits";

/**
 * Document text extraction for chat attachments.
 *
 * Why this exists: pi's built-in `read` tool decodes every non-image file as
 * UTF-8 unconditionally (`dist/core/tools/read.js:189`). Handing it a PDF
 * produces replacement-character mojibake with no error, and the model answers
 * confidently from garbage. For the target user — an engineer checking a clause
 * in a technical standard — a confident wrong answer is worse than "cannot read
 * this". Everything here exists to turn silent corruption into either real text
 * or an explicit, actionable failure.
 *
 * Every export is a pure function of its inputs so `tests/unit` can exercise it
 * directly, matching the `web-search.ts` / `web-search.spec.ts` split.
 */

export type DocumentKind = "pdf" | "docx" | "xlsx" | "text" | "image" | "unknown";

export type DocumentFailureReason =
  | "scanned-pdf"
  | "password-protected"
  | "corrupt"
  | "unsupported"
  | "too-large"
  | "empty"
  | "unavailable"
  | "changed"
  | "cancelled"
  | "timeout"
  | "worker-unavailable"
  | "queue-full";

export interface DocumentExtractionMeta {
  /** PDF page count. */
  readonly pages?: number;
  /** Worksheet names, in workbook order. */
  readonly sheets?: readonly string[];
  /** Which decoder produced the text, for non-UTF-8 plain text files. */
  readonly encoding?: string;
  /** True when `text` was cut at the character budget. */
  readonly truncated?: boolean;
  readonly complete?: boolean;
  readonly charLimit?: number;
  readonly extractedChars?: number;
}

export interface DocumentExtractionSuccess {
  readonly ok: true;
  readonly kind: DocumentKind;
  readonly text: string;
  readonly meta: DocumentExtractionMeta;
  /**
   * Per-page text, kept only when the extractor already had it (PDFs, which
   * pdf.js hands over page by page before they are joined). read_document pages
   * through exactly these, so keeping them costs one array and saves a second
   * full parse of the file. Bounded by the document limit, independently of
   * preview truncation; incomplete extraction is always reported in metadata.
   */
  readonly pageTexts?: readonly string[];
  /** Complete readable sections, independent of the bounded preview text. */
  readonly sectionTexts?: readonly string[];
}

export interface DocumentExtractionFailure {
  readonly ok: false;
  readonly kind: DocumentKind;
  readonly reason: DocumentFailureReason;
  /** Free-form detail for logs; user-facing copy is chosen from `reason`. */
  readonly detail?: string;
  readonly code?: string;
}

export type DocumentExtraction = DocumentExtractionSuccess | DocumentExtractionFailure;

export interface ExtractDocumentOptions {
  /** Hard cap on input size. Larger files fail rather than stall the app. */
  readonly maxBytes?: number;
  /** Hard cap on extracted characters. Longer output is truncated and flagged. */
  readonly maxChars?: number;
}

const PDF_MAGIC = "%PDF-";
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

/**
 * Extensions lie — a `.txt` that is really a PDF is exactly the case that
 * produces mojibake today — so content is authoritative and the file name is
 * only consulted when the bytes are inconclusive.
 */
export function sniffDocumentKind(buffer: Uint8Array, fileName?: string): DocumentKind {
  if (startsWithAscii(buffer, PDF_MAGIC)) {
    return "pdf";
  }
  if (startsWithBytes(buffer, ZIP_MAGIC)) {
    const entries = inspectDocumentZip(buffer);
    const typesEntry = entries.get("[Content_Types].xml");
    if (!typesEntry) return "unknown";
    if (typesEntry.originalSize > 256 * 1024) throw new DocumentZipError("too-large", "Office content types exceed the metadata budget.");
    const types = new TextDecoder().decode(readDocumentZipParts(buffer, (name) => name === "[Content_Types].xml")["[Content_Types].xml"]);
    if (entries.has("word/document.xml") && types.includes("wordprocessingml.document.main+xml")) {
      return "docx";
    }
    if (entries.has("xl/workbook.xml") && /spreadsheetml.sheet.main\+xml|ms-excel.sheet.macroEnabled.main\+xml/.test(types)) {
      return "xlsx";
    }
    return "unknown";
  }
  if (isImageMagic(buffer)) {
    return "image";
  }
  if (looksLikeText(buffer)) {
    return "text";
  }
  return extensionKind(fileName) ?? "unknown";
}

/**
 * Decodes plain text without a declared charset. Strict UTF-8 first: it rejects
 * invalid sequences instead of silently substituting U+FFFD, which makes it a
 * reliable detector. GBK/GB18030 is the fallback because a large share of
 * domestic technical material still ships in it, and that is precisely the
 * content that turns into mojibake today.
 */
export function decodeTextBuffer(buffer: Uint8Array): { readonly text: string; readonly encoding: string } {
  if (hasUtf8Bom(buffer)) {
    return { text: new TextDecoder("utf-8").decode(buffer.subarray(3)), encoding: "utf-8" };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { text: new TextDecoder("utf-16le").decode(buffer.subarray(2)), encoding: "utf-16le" };
  }
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    return { text: new TextDecoder("utf-16be").decode(buffer.subarray(2)), encoding: "utf-16be" };
  }
  const inferredUtf16 = inferUtf16Encoding(buffer);
  if (inferredUtf16) {
    return { text: new TextDecoder(inferredUtf16).decode(buffer), encoding: inferredUtf16 };
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(buffer), encoding: "utf-8" };
  } catch {
    // gb18030 is a strict superset of GBK/GB2312, so one decoder covers all
    // three of the encodings this content realistically arrives in.
    return { text: new TextDecoder("gb18030").decode(buffer), encoding: "gb18030" };
  }
}

function inferUtf16Encoding(buffer: Uint8Array): "utf-16le" | "utf-16be" | undefined {
  const sampleLength = Math.min(buffer.length - (buffer.length % 2), 4096);
  if (sampleLength < 8) {
    return undefined;
  }
  let evenNuls = 0;
  let oddNuls = 0;
  for (let index = 0; index < sampleLength; index += 2) {
    if (buffer[index] === 0) evenNuls += 1;
    if (buffer[index + 1] === 0) oddNuls += 1;
  }
  const pairs = sampleLength / 2;
  if (oddNuls / pairs >= 0.3 && oddNuls >= evenNuls * 2) {
    return "utf-16le";
  }
  if (evenNuls / pairs >= 0.3 && evenNuls >= oddNuls * 2) {
    return "utf-16be";
  }
  return undefined;
}

/**
 * PDF producers routinely emit Kangxi radicals (U+2F00–U+2FDF) and CJK radical
 * supplements (U+2E80–U+2EFF) in place of the identical-looking unified
 * ideographs, so extracted text reads correctly but no longer matches a search
 * for the real characters (`⽕⼒` vs `火力`). Those two blocks are pure visual
 * duplicates and are safe to fold.
 *
 * Full NFKC is deliberately NOT used: it also rewrites `㎡`→`m2`, `℃`→`°C` and
 * `①`→`1`, which is lossy in exactly the engineering documents this targets.
 */
export function normalizeExtractedText(text: string): string {
  return text
    .replace(/[⺀-⻿⼀-⿟]/g, (char) => char.normalize("NFKC"))
    .replace(/\r\n?/g, "\n")
    // NUL, soft hyphen and zero-width marks survive PDF extraction: they are
    // invisible to every reader but break substring matching for the model.
    .replace(/[\u0000\u00ad\u200b-\u200d\ufeff]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function extractPdf(buffer: Uint8Array, maxChars: number): Promise<DocumentExtraction> {
  const perPage = await extractPdfPages(buffer);
  if ("ok" in perPage) {
    return perPage;
  }
  return successFromParts("pdf", perPage.pages, maxChars, { pages: perPage.totalPages, complete: perPage.complete });
}

/**
 * Per-page text, so `read_document` can page through a long standard instead of
 * pushing the whole thing into the context window.
 *
 * A PDF with pages but no text layer is a scan. Reporting that rather than
 * returning "" is the whole point: the caller can tell the user to ask with a
 * screenshot (the multimodal path already works) instead of letting the model
 * invent an answer about a document it cannot see.
 */
export async function extractPdfPages(
  buffer: Uint8Array,
): Promise<{ readonly pages: readonly string[]; readonly totalPages: number; readonly complete: boolean } | DocumentExtractionFailure> {
  const perPage = await pdfPageTexts(buffer);
  if ("ok" in perPage) {
    return perPage;
  }
  const pages = perPage.pages.map((page) => normalizeExtractedText(page));
  if (pages.every((page) => page === "")) {
    return { ok: false, kind: "pdf", reason: "scanned-pdf", detail: `${pages.length} page(s), no text layer` };
  }
  return { pages, totalPages: perPage.totalPages, complete: perPage.complete };
}

async function pdfPageTexts(
  buffer: Uint8Array,
): Promise<{ readonly pages: readonly string[]; readonly totalPages: number; readonly complete: boolean } | DocumentExtractionFailure> {
  const { getDocumentProxy } = await import("unpdf");
  try {
    const document = await getDocumentProxy(buffer);
    try {
      if (document.numPages > 2_000) return { ok: false, kind: "pdf", reason: "too-large", detail: "PDF page limit exceeded." };
      const pages: string[] = [];
      let chars = 0;
      for (let number = 1; number <= document.numPages; number++) {
        const page = await document.getPage(number);
        const content = await page.getTextContent();
        const text = normalizeExtractedText(content.items.map((item) => "str" in item ? `${item.str}${item.hasEOL ? "\n" : ""}` : "").join(""));
        const remaining = MAX_DOCUMENT_CHARS - chars;
        pages.push(text.slice(0, remaining));
        chars += text.length;
        page.cleanup();
        if (chars >= MAX_DOCUMENT_CHARS) return { pages, totalPages: document.numPages, complete: chars === MAX_DOCUMENT_CHARS && number === document.numPages };
      }
      return { pages, totalPages: document.numPages, complete: true };
    } finally { await document.loadingTask.destroy(); }
  } catch (error) {
    return pdfFailure(error);
  }
}

/**
 * Splits long non-paginated text into readable windows on paragraph boundaries,
 * giving `read_document` the same "fetch part N" shape that PDF pages provide.
 */
export function segmentText(text: string, maxChars = 4_000): readonly string[] {
  if (text.length <= maxChars) {
    return text ? [text] : [];
  }
  const segments: string[] = [];
  let current = "";
  for (const paragraph of text.split("\n\n")) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    if (current) {
      segments.push(current);
      current = "";
    }
    // A single paragraph past the budget still has to be delivered, so cut it
    // on the character boundary rather than dropping it.
    for (let start = 0; start < paragraph.length; start += maxChars) {
      const slice = paragraph.slice(start, start + maxChars);
      if (slice.length === maxChars) {
        segments.push(slice);
      } else {
        current = slice;
      }
    }
  }
  if (current) {
    segments.push(current);
  }
  return segments;
}

export async function extractDocx(buffer: Uint8Array, maxChars: number): Promise<DocumentExtraction> {
  const mammoth = (await import("mammoth")).default;
  let raw: string;
  try {
    inspectDocumentZip(buffer);
    const result = await mammoth.extractRawText({ buffer: Buffer.from(buffer) });
    raw = result.value;
  } catch (error) {
    return { ok: false, kind: "docx", reason: error instanceof DocumentZipError ? error.reason : "corrupt", detail: errorMessage(error) };
  }

  const text = normalizeExtractedText(raw);
  if (!text) {
    return { ok: false, kind: "docx", reason: "empty" };
  }
  return success("docx", text, maxChars, {});
}

export async function extractXlsx(buffer: Uint8Array, maxChars: number): Promise<DocumentExtraction> {
  let workbook: XlsxWorkbook;
  try {
    workbook = readXlsx(buffer);
  } catch (error) {
    return { ok: false, kind: "xlsx", reason: error instanceof DocumentZipError ? error.reason : "corrupt", detail: errorMessage(error) };
  }

  const sheets: string[] = [];
  const blocks: string[] = [];
  for (const sheet of workbook.sheets) {
    sheets.push(sheet.name);
    let rows: string[] = [];
    let firstRow = 0;
    let lastRow = 0;
    let chars = 0;
    const flush = () => {
      if (rows.length) blocks.push(`## ${sheet.name} — rows ${firstRow}–${lastRow}\n${rows.join("\n")}`);
      rows = []; chars = 0;
    };
    for (const [index, cells] of sheet.rows.entries()) {
      const rowNumber = sheet.rowNumbers?.[index] ?? index + 1;
      for (const line of segmentText(normalizeExtractedText(cells.join("\t")), 3_700)) {
        if (chars + line.length > 3_700) flush();
        if (!rows.length) firstRow = rowNumber;
        lastRow = rowNumber;
        rows.push(line); chars += line.length + 1;
      }
    }
    flush();
    if (!sheet.rows.length) blocks.push(`## ${sheet.name}\n(空工作表)`);
  }

  if (!blocks.length) {
    return { ok: false, kind: "xlsx", reason: "empty" };
  }
  return successFromParts("xlsx", blocks, maxChars, { sheets });
}

export async function extractPlainText(buffer: Uint8Array, maxChars: number): Promise<DocumentExtraction> {
  const { text, encoding } = decodeTextBuffer(buffer);
  const normalized = normalizeExtractedText(text);
  if (!normalized) {
    return { ok: false, kind: "text", reason: "empty" };
  }
  return success("text", normalized, maxChars, { encoding });
}

/**
 * Single entry point: sniff, dispatch, and enforce the size budgets. Images are
 * reported as unsupported here because the attachment pipeline already has a
 * working multimodal path for them.
 */
export async function extractDocument(
  buffer: Uint8Array,
  fileName?: string,
  options: ExtractDocumentOptions = {},
): Promise<DocumentExtraction> {
  const maxBytes = options.maxBytes ?? MAX_DOCUMENT_BYTES;
  const maxChars = options.maxChars ?? MAX_EXTRACTED_CHARS;
  if (buffer.byteLength > maxBytes) {
    return { ok: false, kind: "unknown", reason: "too-large", detail: `${buffer.byteLength} bytes exceeds ${maxBytes}` };
  }
  if (buffer.byteLength === 0) {
    return { ok: false, kind: "unknown", reason: "empty" };
  }
  let kind: DocumentKind;
  try { kind = sniffDocumentKind(buffer, fileName); }
  catch (error) { return { ok: false, kind: "unknown", reason: error instanceof DocumentZipError ? error.reason : "corrupt", detail: errorMessage(error) }; }

  switch (kind) {
    case "pdf":
      return extractPdf(buffer, maxChars);
    case "docx":
      return extractDocx(buffer, maxChars);
    case "xlsx":
      return extractXlsx(buffer, maxChars);
    case "text":
      return extractPlainText(buffer, maxChars);
    case "image":
      return { ok: false, kind, reason: "unsupported", detail: "images use the multimodal attachment path" };
    default:
      return { ok: false, kind, reason: "unsupported" };
  }
}

function success(
  kind: DocumentKind,
  text: string,
  maxChars: number,
  meta: DocumentExtractionMeta,
): DocumentExtractionSuccess {
  return successFromParts(kind, segmentText(text.slice(0, MAX_DOCUMENT_CHARS)), maxChars,
    { ...meta, complete: text.length <= MAX_DOCUMENT_CHARS });
}

function successFromParts(kind: DocumentKind, source: readonly string[], maxChars: number, meta: DocumentExtractionMeta): DocumentExtractionSuccess {
  const parts: string[] = [];
  let chars = 0;
  let complete = meta.complete !== false;
  for (const part of source) {
    if (chars + part.length > MAX_DOCUMENT_CHARS) {
      parts.push(part.slice(0, MAX_DOCUMENT_CHARS - chars));
      chars = MAX_DOCUMENT_CHARS;
      complete = false;
      break;
    }
    parts.push(part); chars += part.length;
  }
  let preview = "";
  for (const part of parts) {
    if (preview.length >= maxChars) break;
    preview += `${preview ? "\n\n" : ""}${part}`.slice(0, maxChars - preview.length);
  }
  const truncated = chars > maxChars || !complete;
  return {
    ok: true,
    kind,
    text: preview,
    meta: { ...meta, complete, extractedChars: chars, ...(complete ? {} : { charLimit: MAX_DOCUMENT_CHARS }), ...(truncated ? { truncated: true } : {}) },
    ...(kind === "pdf" ? { pageTexts: parts } : { sectionTexts: parts }),
  };
}

function pdfFailure(error: unknown): DocumentExtractionFailure {
  const message = errorMessage(error);
  // pdf.js signals encryption through a named error rather than a code.
  const protectedDocument = /password/i.test(message) || /PasswordException/.test(message);
  return {
    ok: false,
    kind: "pdf",
    reason: protectedDocument ? "password-protected" : "corrupt",
    detail: message,
  };
}

function startsWithAscii(buffer: Uint8Array, prefix: string): boolean {
  if (buffer.byteLength < prefix.length) {
    return false;
  }
  for (let index = 0; index < prefix.length; index += 1) {
    if (buffer[index] !== prefix.charCodeAt(index)) {
      return false;
    }
  }
  return true;
}

function startsWithBytes(buffer: Uint8Array, prefix: readonly number[]): boolean {
  if (buffer.byteLength < prefix.length) {
    return false;
  }
  return prefix.every((byte, index) => buffer[index] === byte);
}

function isImageMagic(buffer: Uint8Array): boolean {
  return (
    startsWithBytes(buffer, [0x89, 0x50, 0x4e, 0x47]) || // PNG
    startsWithBytes(buffer, [0xff, 0xd8, 0xff]) || // JPEG
    startsWithAscii(buffer, "GIF8") ||
    startsWithBytes(buffer, [0x42, 0x4d]) || // BMP
    (startsWithAscii(buffer, "RIFF") && latin1(buffer.subarray(0, 16)).includes("WEBP"))
  );
}

/**
 * Treats the leading bytes as text when they decode cleanly and carry no NUL —
 * the marker that separates real text files (in any of the encodings we handle)
 * from binary formats we have no parser for.
 */
function looksLikeText(buffer: Uint8Array): boolean {
  const sample = buffer.subarray(0, 4096);
  if (sample.byteLength === 0) {
    return false;
  }
  if (sample.includes(0x00)) {
    return false;
  }
  if (hasUtf8Bom(buffer)) {
    return true;
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
    return true;
  } catch {
    // Not UTF-8; accept it as text only if the bytes look like plausible GBK
    // rather than arbitrary binary.
    return looksLikeGbk(sample);
  }
}

function looksLikeGbk(sample: Uint8Array): boolean {
  let index = 0;
  let doubleByte = 0;
  while (index < sample.byteLength) {
    const byte = sample[index];
    if (byte === undefined) {
      break;
    }
    if (byte < 0x80) {
      index += 1;
      continue;
    }
    const next = sample[index + 1];
    const leadOk = byte >= 0x81 && byte <= 0xfe;
    const trailOk = next !== undefined && next >= 0x40 && next <= 0xfe && next !== 0x7f;
    if (!leadOk || !trailOk) {
      // A truncated trailing byte at the sample boundary is not evidence of
      // binary content; anything else is.
      return next === undefined && leadOk ? doubleByte > 0 : false;
    }
    doubleByte += 1;
    index += 2;
  }
  return doubleByte > 0;
}

function hasUtf8Bom(buffer: Uint8Array): boolean {
  return buffer.byteLength >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
}

function latin1(buffer: Uint8Array): string {
  return new TextDecoder("latin1").decode(buffer.subarray(0, 8192));
}

function extensionKind(fileName?: string): DocumentKind | undefined {
  if (!fileName) {
    return undefined;
  }
  switch (path.extname(fileName).toLowerCase()) {
    case ".pdf":
      return "pdf";
    case ".docx":
      return "docx";
    case ".xlsx":
    case ".xlsm":
      return "xlsx";
    case ".txt":
    case ".csv":
    case ".md":
    case ".log":
      return "text";
    default:
      return undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
