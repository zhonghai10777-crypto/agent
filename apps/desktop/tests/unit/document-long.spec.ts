import { mkdir, readFile, writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import ExcelJS from "exceljs";
import mammoth from "mammoth";
import { zipSync, strToU8 } from "fflate";
import { getDocumentExtraction, getDocumentParts, invalidateDocumentCache } from "../../electron/document-cache";
import { extractDocument, MAX_DOCUMENT_CHARS, sniffDocumentKind } from "../../electron/document-extract";
import { LibraryIndex } from "../../electron/library-index";
import { searchLibraryDocuments } from "../../electron/library-runtime";
import { builtDocumentWorker } from "../helpers/document-worker";
import { makeLongDocuments } from "../helpers/long-documents";

test("actual TXT, DOCX and XLSX extraction, pagination and index reach markers beyond 400k", async ({}, info) => {
  const documents = await makeLongDocuments(info.outputPath("sources"));
  // Independent OOXML readers establish that late-entry fixtures are valid.
  expect((await mammoth.extractRawText({ path: documents[1]!.path })).value).toContain(documents[1]!.marker);
  const xlsx = new ExcelJS.Workbook();
  await xlsx.xlsx.readFile(documents[2]!.path);
  expect(xlsx.worksheets[0]!.lastRow?.getCell(2).value).toBe(documents[2]!.marker);
  const worker = builtDocumentWorker();
  try {
    for (const doc of documents) {
      const bytes = new Uint8Array(await readFile(doc.path));
      expect(sniffDocumentKind(bytes, doc.path)).toBe(doc.kind);
      const preview = await getDocumentExtraction(doc.path, { worker });
      expect(preview).toMatchObject({ ok: true, meta: { truncated: true, complete: true } });
      if (!preview.ok) throw new Error(JSON.stringify(preview));
      expect(preview.text.length).toBeLessThanOrEqual(400_000);
      expect(preview.text).not.toContain(doc.marker);
      const parts = await getDocumentParts(doc.path, { worker });
      if ("ok" in parts) throw new Error(JSON.stringify(parts));
      expect(parts.complete).toBe(true);
      expect(parts.parts.at(-1)).toContain(doc.marker);
      expect(parts.parts.reduce((sum, part) => sum + part.length, 0)).toBeGreaterThan(400_000);
      if (doc.kind === "xlsx") expect(parts.parts.at(-1)).toMatch(/Synthetic rows — rows \d+–651/);
    }
    const index = new LibraryIndex(info.outputPath("index"), { getParts: (file, options) => getDocumentParts(file, { ...options, worker }) });
    await index.rebuild([info.outputPath("sources")]);
    for (const doc of documents) {
      const [match] = searchLibraryDocuments(index.documents(), doc.marker);
      expect(match?.snippet).toContain(doc.marker);
      expect(match?.complete).toBe(true);
      const parts = await getDocumentParts(match!.path, { worker, expectedVersion: match!.sourceVersion });
      if ("ok" in parts) throw new Error(JSON.stringify(parts));
      expect(parts.parts[match!.part - 1]).toContain(doc.marker);
      await writeFile(doc.path, "changed after search");
      expect(await getDocumentParts(match!.path, { worker, expectedVersion: match!.sourceVersion })).toMatchObject({ code: "DOCUMENT_CHANGED" });
    }
  } finally { invalidateDocumentCache(); await worker.close(); }
});

test("hard document limit is explicitly partial while preview remains bounded", async ({}, info) => {
  await mkdir(info.outputDir, { recursive: true });
  const result = await extractDocument(strToU8("a".repeat(MAX_DOCUMENT_CHARS + 10)), "large.txt");
  expect(result).toMatchObject({ ok: true, meta: { complete: false, truncated: true, charLimit: MAX_DOCUMENT_CHARS } });
  if (!result.ok) throw new Error("Expected bounded partial extraction");
  expect(result.sectionTexts!.reduce((sum, part) => sum + part.length, 0)).toBe(MAX_DOCUMENT_CHARS);
  expect(result.text.length).toBeLessThanOrEqual(400_000);
});

test("ordinary, corrupt, encrypted and inflated ZIPs are classified without unbounded extraction", async () => {
  const zip = zipSync({ "plain.txt": strToU8("ordinary zip") });
  expect(sniffDocumentKind(zip, "fake.docx")).toBe("unknown");
  expect(await extractDocument(zip.slice(0, -8), "broken.docx")).toMatchObject({ reason: "corrupt" });
  const encrypted = zip.slice();
  new DataView(encrypted.buffer).setUint16(6, 1, true);
  expect(await extractDocument(encrypted, "encrypted.docx")).toMatchObject({ reason: "password-protected" });
  const inflated = zip.slice();
  for (let i = 0; i < inflated.length - 46; i++) {
    if (new DataView(inflated.buffer).getUint32(i, true) === 0x02014b50) {
      new DataView(inflated.buffer).setUint32(i + 24, 40 * 1024 * 1024, true); break;
    }
  }
  expect(await extractDocument(inflated, "bomb.docx")).toMatchObject({ reason: "too-large" });
});
