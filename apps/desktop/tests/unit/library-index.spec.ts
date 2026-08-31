import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { expect, test } from "@playwright/test";
import { LibraryIndex } from "../../electron/library-index";

test("LibraryIndex persists documents, reuses unchanged entries, and reports scans", async ({}, testInfo) => {
  const root = testInfo.outputPath("library-root");
  const indexDir = testInfo.outputPath("library-index");
  await mkdir(root, { recursive: true });
  const textPath = join(root, "运行规程.txt");
  const scanPath = join(root, "扫描规程.pdf");
  await writeFile(textPath, "厂用电源切换应先核对备用电源。", "utf8");
  await writeFile(scanPath, "fixture", "utf8");
  await writeFile(join(root, ".hidden.txt"), "hidden", "utf8");
  await writeFile(join(root, "~$temporary.docx"), "temp", "utf8");

  const calls = new Map<string, number>();
  const getParts = async (filePath: string) => {
    calls.set(filePath, (calls.get(filePath) ?? 0) + 1);
    if (filePath === scanPath) {
      return { ok: false as const, reason: "scanned-pdf" as const, detail: "1 page(s), no text layer" };
    }
    return { unit: "section" as const, parts: [await readFile(filePath, "utf8")] };
  };

  const index = new LibraryIndex(indexDir, { getParts });
  await index.rebuild([root]);
  expect(index.status()).toMatchObject({ state: "ready", total: 2, done: 2, documents: 1, parts: 1 });
  expect(index.documents()).toMatchObject([{ path: textPath, title: "运行规程", unit: "section" }]);
  expect(index.status().skipped).toMatchObject([{ path: scanPath, reasonCode: "scanned-pdf" }]);
  expect(calls.get(textPath)).toBe(1);
  expect(calls.get(scanPath)).toBe(1);

  await index.rebuild([root]);
  expect(calls.get(textPath)).toBe(1);
  expect(calls.get(scanPath)).toBe(1);

  await writeFile(textPath, "厂用电源切换前必须核对备用电源和保护定值。", "utf8");
  await index.rebuild([root]);
  expect(calls.get(textPath)).toBe(2);
  expect(index.documents()[0]?.parts[0]).toContain("保护定值");

  const reloaded = new LibraryIndex(indexDir, {
    getParts: async (filePath) => {
      if (basename(filePath) === "扫描规程.pdf") {
        throw new Error("unchanged persisted scan should not be parsed again");
      }
      throw new Error("unchanged persisted document should not be parsed again");
    },
  });
  await reloaded.rebuild([root]);
  expect(reloaded.documents()[0]?.parts[0]).toContain("保护定值");
  expect(reloaded.status().skipped).toMatchObject([{ path: scanPath, reasonCode: "scanned-pdf" }]);
});

test("LibraryIndex degrades gracefully when a configured directory is unavailable", async ({}, testInfo) => {
  const missing = testInfo.outputPath("missing-directory");
  const index = new LibraryIndex(testInfo.outputPath("missing-index"));
  await index.rebuild([missing]);

  expect(index.status()).toMatchObject({ state: "ready", total: 0, documents: 0 });
  expect(index.status().skipped).toMatchObject([{ path: missing, reasonCode: "unavailable" }]);
});

test("LibraryIndex enforces a configurable character budget and clears memory plus disk", async ({}, testInfo) => {
  const root = testInfo.outputPath("budget-root");
  const indexDir = testInfo.outputPath("budget-index");
  const indexPath = join(indexDir, "index.json");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "a.txt"), "123456", "utf8");
  await writeFile(join(root, "b.txt"), "abcdef", "utf8");

  const index = new LibraryIndex(indexDir, {
    maxIndexedChars: 10,
    getParts: async (filePath) => ({ unit: "section", parts: [await readFile(filePath, "utf8")] }),
  });
  await index.rebuild([root]);

  expect(index.documents()).toHaveLength(1);
  expect(index.status().skipped).toContainEqual(expect.objectContaining({ reasonCode: "capacity" }));
  await expect(readFile(indexPath, "utf8")).resolves.toContain('"version":1');

  await index.clear({ deleteDisk: true });
  expect(index.documents()).toEqual([]);
  expect(index.status()).toMatchObject({ state: "idle", documents: 0, parts: 0 });
  await expect(readFile(indexPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});
