import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { zipSync, strToU8 } from "fflate";
import { readXlsx } from "../../electron/xlsx-reader";

const fixtures = path.resolve(__dirname, "..", "fixtures", "documents");
const load = async (name: string) => new Uint8Array(await readFile(path.join(fixtures, name)));

test("reads every sheet in workbook order with its name", async () => {
  const workbook = readXlsx(await load("standard-zh.xlsx"));

  expect(workbook.sheets.map((sheet) => sheet.name)).toEqual(["运行参数", "缺陷台账"]);
  expect(workbook.sheets[0]?.rows[0]).toEqual(["参数", "设计值", "实测值"]);
  expect(workbook.sheets[0]?.rows[1]).toEqual(["主蒸汽压力(MPa)", "16.7", "16.5"]);
  expect(workbook.sheets[1]?.rows[1]).toEqual(["D-001", "给水泵密封泄漏"]);
});

test("renders date-formatted cells as dates rather than serial numbers", async () => {
  const workbook = readXlsx(await load("tricky-zh.xlsx"));
  const row = workbook.sheets[0]?.rows[1];

  // Left as the raw serial, a defect log's dates reach the model as five-digit
  // numbers it will reason about as quantities.
  expect(row?.[1]).toBe("2025-01-15");
  // A plain number in the same row must NOT be date-converted.
  expect(row?.[3]).toBe("3");
});

test("uses the workbook 1904 date system when requested", () => {
  const workbook = readXlsx(zipSync({
    "xl/workbook.xml": strToU8(
      '<workbook><workbookPr date1904="1"/><sheets><sheet name="Dates" r:id="rId1"/></sheets></workbook>',
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    ),
    "xl/styles.xml": strToU8(
      '<styleSheet><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>',
    ),
    "xl/worksheets/sheet1.xml": strToU8(
      '<worksheet><sheetData><row><c r="A1" s="1"><v>1</v></c></row></sheetData></worksheet>',
    ),
  }));

  expect(workbook.sheets[0]?.rows[0]?.[0]).toBe("1904-01-02");
});

test("decodes XML-escaped cell text", async () => {
  const workbook = readXlsx(await load("tricky-zh.xlsx"));

  expect(workbook.sheets[0]?.rows[1]?.[2]).toBe("阀门 A&B <泄漏>");
});

test("keeps column alignment across gaps in a sparse row", async () => {
  const workbook = readXlsx(await load("tricky-zh.xlsx"));
  const sparse = workbook.sheets[0]?.rows[2];

  // Row 3 sets only columns A and D. Collapsing the gap would slide 7 under the
  // "发现日期" header and silently misreport the table.
  expect(sparse).toEqual(["D-003", "", "", "7"]);
});

test("uses the cached result of a formula cell", async () => {
  const workbook = readXlsx(await load("tricky-zh.xlsx"));

  expect(workbook.sheets[0]?.rows[3]?.[0]).toBe("2");
});

test("keeps an empty sheet as a named sheet with no rows", async () => {
  const workbook = readXlsx(await load("tricky-zh.xlsx"));
  const empty = workbook.sheets.find((sheet) => sheet.name === "空表");

  expect(empty).toBeDefined();
  expect(empty?.rows).toEqual([]);
});

test("rejects a non-xlsx payload instead of returning empty sheets", async () => {
  // A .docx is also a ZIP, so the guard has to be the workbook part, not the
  // ZIP magic that sniffing already matched.
  expect(() => readXlsx(new Uint8Array([1, 2, 3, 4]))).toThrow();
  expect(() => readXlsx(new Uint8Array(0))).toThrow();
  await expect(load("standard-zh.docx").then((buffer) => readXlsx(buffer))).rejects.toThrow(
    /xl\/workbook\.xml/,
  );
});
