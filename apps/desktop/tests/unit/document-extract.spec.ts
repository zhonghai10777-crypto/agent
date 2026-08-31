import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  decodeTextBuffer,
  extractDocument,
  normalizeExtractedText,
  sniffDocumentKind,
} from "../../electron/document-extract";

const fixtures = path.resolve(__dirname, "..", "fixtures", "documents");
const load = async (name: string) => new Uint8Array(await readFile(path.join(fixtures, name)));

test("sniffs by magic bytes, not by the extension the file claims", async () => {
  const pdf = await load("standard-zh.pdf");
  const docx = await load("standard-zh.docx");
  const xlsx = await load("standard-zh.xlsx");

  expect(sniffDocumentKind(pdf, "standard-zh.pdf")).toBe("pdf");
  expect(sniffDocumentKind(docx, "standard-zh.docx")).toBe("docx");
  expect(sniffDocumentKind(xlsx, "standard-zh.xlsx")).toBe("xlsx");

  // The case that produces mojibake today: a binary document wearing a text
  // extension. Content has to win, otherwise it goes down the UTF-8 path.
  expect(sniffDocumentKind(pdf, "规程.txt")).toBe("pdf");
  expect(sniffDocumentKind(docx, "notes.csv")).toBe("docx");
  // Both OOXML kinds share the ZIP magic, so they must not collapse together.
  expect(sniffDocumentKind(xlsx, "report.docx")).toBe("xlsx");
});

test("extracts a PDF text layer with page count", async () => {
  const result = await extractDocument(await load("standard-zh.pdf"), "standard-zh.pdf");

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.kind).toBe("pdf");
  expect(result.meta.pages).toBe(2);
  expect(result.text).toContain("额定负荷下锅炉效率不低于 92%");
  // Page two must survive: a single-page extraction would still look "ok".
  expect(result.text).toContain("机组启动前应完成全部保护投入试验");
});

test("reports a scanned PDF as scanned instead of returning empty text", async () => {
  const result = await extractDocument(await load("scanned-zh.pdf"), "scanned-zh.pdf");

  // This is the whole point of the feature: an image-only PDF must produce an
  // explicit, actionable failure. Returning "" would let the model answer
  // confidently about a document it cannot actually see.
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toBe("scanned-pdf");
  expect(result.kind).toBe("pdf");
});

test("extracts Word text including table cells", async () => {
  const result = await extractDocument(await load("standard-zh.docx"), "standard-zh.docx");

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.kind).toBe("docx");
  expect(result.text).toContain("设备缺陷分析报告");
  expect(result.text).toContain("额定负荷下锅炉效率不低于 92%");
  // Table cells are body content here, not decoration — losing them loses data.
  expect(result.text).toContain("缺陷等级");
  expect(result.text).toContain("2 号机");
});

test("extracts every Excel sheet with its name", async () => {
  const result = await extractDocument(await load("standard-zh.xlsx"), "standard-zh.xlsx");

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.kind).toBe("xlsx");
  expect(result.meta.sheets).toEqual(["运行参数", "缺陷台账"]);
  expect(result.text).toContain("主蒸汽压力(MPa)");
  // A workbook read that stops at sheet one is a silent data loss bug.
  expect(result.text).toContain("给水泵密封泄漏");
});

test("decodes GBK technical exports without mojibake", async () => {
  const gbk = await load("gbk-sample.csv");
  const utf8 = await load("utf8-sample.csv");

  expect(decodeTextBuffer(gbk).encoding).toBe("gb18030");
  expect(decodeTextBuffer(gbk).text).toContain("机组,负荷,效率");
  expect(decodeTextBuffer(utf8).encoding).toBe("utf-8");
  expect(decodeTextBuffer(utf8).text).toContain("机组,负荷,效率");

  const result = await extractDocument(gbk, "gbk-sample.csv");
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.meta.encoding).toBe("gb18030");
  expect(result.text).toContain("1 号机,300MW,92.4%");
  // The mojibake signature the old path produced.
  expect(result.text).not.toContain("�");
});

test("decodes Windows UTF-16LE and UTF-16BE text with or without a BOM", () => {
  const text = "机组,负荷,效率\r\n1号机,300MW,92.4%";
  const utf16leBody = Buffer.from(text, "utf16le");
  const utf16le = new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xfe]), utf16leBody]));
  const utf16beBody = new Uint8Array(utf16leBody.length);
  for (let index = 0; index < utf16leBody.length; index += 2) {
    utf16beBody[index] = utf16leBody[index + 1] ?? 0;
    utf16beBody[index + 1] = utf16leBody[index] ?? 0;
  }

  expect(decodeTextBuffer(utf16le)).toEqual({ text, encoding: "utf-16le" });
  expect(decodeTextBuffer(utf16beBody)).toEqual({ text, encoding: "utf-16be" });
});

test("folds duplicate CJK radicals but preserves engineering notation", () => {
  // PDF producers emit Kangxi radicals that look identical to the real
  // ideographs, so a search for 火力 silently misses ⽕⼒.
  expect(normalizeExtractedText("⽕⼒发电机组运⾏规程")).toBe("火力发电机组运行规程");

  // Full NFKC would rewrite these; that is lossy for the documents this targets.
  expect(normalizeExtractedText("承压面积 12㎡，温度 540℃，第①款")).toBe("承压面积 12㎡，温度 540℃，第①款");
  expect(normalizeExtractedText("２０２４年")).toBe("２０２４年");
});

test("rejects oversized input and flags truncation rather than failing silently", async () => {
  const pdf = await load("standard-zh.pdf");

  const tooLarge = await extractDocument(pdf, "standard-zh.pdf", { maxBytes: 1024 });
  expect(tooLarge.ok).toBe(false);
  if (!tooLarge.ok) {
    expect(tooLarge.reason).toBe("too-large");
  }

  const truncated = await extractDocument(pdf, "standard-zh.pdf", { maxChars: 20 });
  expect(truncated.ok).toBe(true);
  if (!truncated.ok) return;
  expect(truncated.text.length).toBe(20);
  expect(truncated.meta.truncated).toBe(true);
});

test("treats an empty file and an unknown binary as explicit failures", async () => {
  const empty = await extractDocument(new Uint8Array(0), "empty.txt");
  expect(empty.ok).toBe(false);
  if (!empty.ok) {
    expect(empty.reason).toBe("empty");
  }

  // Arbitrary binary with NULs must not be mistaken for text and decoded.
  const binary = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x42]);
  expect(sniffDocumentKind(binary, "mystery.bin")).toBe("unknown");
  const result = await extractDocument(binary, "mystery.bin");
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reason).toBe("unsupported");
  }
});
