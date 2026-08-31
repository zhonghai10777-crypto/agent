import { expect, test } from "@playwright/test";
import type { LibraryIndexReader, LibraryIndexStatus } from "../../electron/library-index";
import {
  createLibraryRuntimeTools,
  describeLibraryMisconfiguration,
  searchLibraryDocuments,
} from "../../electron/library-runtime";
import { DEFAULT_LIBRARY_SETTINGS } from "../../electron/library-store";

const documents = [
  {
    path: "/library/运行规程.pdf",
    title: "运行规程",
    key: "a",
    unit: "page" as const,
    parts: [
      "厂用电源切换应检查备用电源。",
      `前言${"甲".repeat(230)}厂用电源切换必须核对保护定值${"乙".repeat(230)}结尾`,
    ],
  },
  {
    path: "/library/保护规程.docx",
    title: "保护规程",
    key: "b",
    unit: "section" as const,
    parts: ["保护定值需要双人复核。保护定值变更后再次复核。"],
  },
] as const;

test("searchLibraryDocuments uses multi-term AND matching, frequency ranking, and bounded snippets", () => {
  const andMatches = searchLibraryDocuments(documents, "厂用电源切换 保护定值", 8);
  expect(andMatches).toHaveLength(1);
  expect(andMatches[0]).toMatchObject({ title: "运行规程", part: 2, unit: "page" });
  expect(andMatches[0]?.snippet.startsWith("…")).toBe(true);
  expect(andMatches[0]?.snippet.endsWith("…")).toBe(true);

  const ranked = searchLibraryDocuments(documents, "保护定值", 8);
  expect(ranked.map((match) => match.title)).toEqual(["保护规程", "运行规程"]);

  const startBoundary = searchLibraryDocuments(documents, "厂用电源切换", 1)[0];
  expect(startBoundary?.snippet.startsWith("…")).toBe(false);
});

test("library tools explain disabled state and return paths for read_document", async () => {
  const disabledIndex = fakeIndex(documents);
  const disabledTool = createLibraryRuntimeTools(() => DEFAULT_LIBRARY_SETTINGS, disabledIndex)[0];
  const disabled = await disabledTool?.execute("disabled", { query: "保护定值" });
  expect(disabled?.content[0]?.text).toContain("turned off");
  expect(describeLibraryMisconfiguration(DEFAULT_LIBRARY_SETTINGS)).toContain("turned off");

  const enabledIndex = fakeIndex(documents);
  const searchTool = createLibraryRuntimeTools(
    () => ({ enabled: true, roots: ["/library"] }),
    enabledIndex,
  )[0];
  const result = await searchTool?.execute("search", { query: "保护定值", limit: 2 });
  expect(result?.content[0]?.text).toContain("《保护规程》 第 1 节");
  expect(result?.content[0]?.text).toContain("Path: /library/保护规程.docx");
  expect(enabledIndex.rebuildCalls).toBe(0);

  const listTool = createLibraryRuntimeTools(
    () => ({ enabled: true, roots: ["/library"] }),
    fakeIndex(documents),
  )[1];
  const listed = await listTool?.execute("list", { filter: "保护" });
  expect(listed?.content[0]?.text).toContain("《保护规程》 — 1 section(s)");
  expect(listed?.details).toMatchObject({
    offset: 0,
    limit: 50,
    total: 1,
    documents: [{ path: "/library/保护规程.docx", title: "保护规程", parts: 1 }],
  });
  expect((listed?.details as { documents?: readonly unknown[] } | undefined)?.documents).not.toEqual(documents);
});

function fakeIndex(indexedDocuments: typeof documents): LibraryIndexReader & { rebuildCalls: number } {
  let status: LibraryIndexStatus = {
    state: "ready",
    total: indexedDocuments.length,
    done: indexedDocuments.length,
    documents: indexedDocuments.length,
    parts: indexedDocuments.reduce((total, document) => total + document.parts.length, 0),
    skipped: [],
  };
  return {
    rebuildCalls: 0,
    async rebuild() {
      this.rebuildCalls += 1;
      status = { ...status, state: "ready" };
    },
    async clear() {
      status = { state: "idle", total: 0, done: 0, documents: 0, parts: 0, skipped: [] };
    },
    status: () => status,
    documents: () => indexedDocuments,
  };
}
