import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import { strToU8, unzipSync, zipSync } from "fflate";

/** Synthetic, valid OOXML with important parts beyond an 8 KiB prefix. */
export async function makeLongDocuments(directory: string) {
  await mkdir(directory, { recursive: true });
  const lines = Array.from({ length: 650 }, (_, i) => `Record ${i}: ${"synthetic reference text for pagination ".repeat(20)}`);
  const entries: { path: string; marker: string; kind: "text" | "docx" | "xlsx" }[] = [];
  const txt = path.join(directory, "long.txt");
  await writeFile(txt, [...lines, "TAIL_TXT_20260913"].join("\n\n"));
  entries.push({ path: txt, marker: "TAIL_TXT_20260913", kind: "text" });

  const base = unzipSync(new Uint8Array(await readFile(path.resolve(__dirname, "../fixtures/documents/standard-zh.docx"))));
  base["word/document.xml"] = strToU8(`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${
    [...lines, "TAIL_DOCX_20260913"].map((line) => `<w:p><w:r><w:t>${line}</w:t></w:r></w:p>`).join("")
  }<w:sectPr/></w:body></w:document>`);
  const docx = path.join(directory, "long.docx");
  await writeFile(docx, zipSync({ "padding.bin": [new Uint8Array(12_000), { level: 0 }], ...base }));
  entries.push({ path: docx, marker: "TAIL_DOCX_20260913", kind: "docx" });

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Synthetic rows");
  for (const [index, line] of lines.entries()) sheet.addRow([index + 1, line]);
  sheet.addRow([lines.length + 1, "TAIL_XLSX_20260913"]);
  const xlsxParts = unzipSync(new Uint8Array(await workbook.xlsx.writeBuffer()));
  const xlsx = path.join(directory, "long.xlsx");
  await writeFile(xlsx, zipSync({ "padding.bin": [new Uint8Array(12_000), { level: 0 }], ...xlsxParts }));
  entries.push({ path: xlsx, marker: "TAIL_XLSX_20260913", kind: "xlsx" });
  return entries;
}
