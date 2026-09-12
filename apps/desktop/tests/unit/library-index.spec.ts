import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { expect, test } from "@playwright/test";
import { LibraryIndex } from "../../electron/library-index";
import { createLibraryRuntimeTools } from "../../electron/library-runtime";
import { writeFileAtomicQueued } from "../../electron/atomic-file-write";
import { authorizeDocumentRead } from "../../electron/document-access";

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

test("transient failures expire with unchanged metadata; explicit retry overrides permanent failures", async ({}, info) => {
  const root = info.outputPath("root"); await mkdir(root, { recursive: true });
  const file = join(root, "file.txt"); await writeFile(file, "recoverable");
  let now = 100;
  let calls = 0;
  let permanent = false;
  const index = new LibraryIndex(info.outputPath("index"), { now: () => now,
    getParts: async (_file, options) => {
      calls++;
      if (calls === 1 || permanent && !options?.retryFailures) return { ok: false, reason: permanent ? "password-protected" : "unavailable" };
      return { unit: "section", parts: ["recovered"] };
    },
  });
  await index.rebuild([root]);
  expect(index.status().skipped[0]?.reason).toContain("temporarily unavailable");
  await index.rebuild([root]); expect(calls).toBe(1);
  now += 1_001;
  await index.rebuild([root]); expect(calls).toBe(2);
  expect(index.documents()[0]?.parts).toEqual(["recovered"]);
  permanent = true; await writeFile(file, "changed synthetic file");
  await index.rebuild([root]); expect(calls).toBe(3);
  await index.rebuild([root]); expect(calls).toBe(3);
  await index.rebuild([root], undefined, { retryFailures: true });
  expect(calls).toBe(4); expect(index.documents()).toHaveLength(1);
});

test("capacity omissions are reevaluated after space is freed", async ({}, info) => {
  const root = info.outputPath("root"); await mkdir(root, { recursive: true });
  await writeFile(join(root, "a.txt"), "123456"); await writeFile(join(root, "b.txt"), "abcdef");
  const index = new LibraryIndex(info.outputPath("index"), { maxIndexedChars: 10,
    getParts: async (file) => ({ unit: "section", parts: [await readFile(file, "utf8")] }) });
  await index.rebuild([root]);
  expect(index.status().skipped[0]?.reasonCode).toBe("capacity");
  await rename(join(root, "a.txt"), info.outputPath("retained-a.txt"));
  await index.rebuild([root]);
  expect(index.documents().map((doc) => doc.title)).toEqual(["b"]);
  expect(index.status().skipped).toEqual([]);
});

test("v1 failed index records retry once; upgraded entries persist their backoff", async ({}, info) => {
  const root = info.outputPath("root"); const indexDir = info.outputPath("index");
  await mkdir(root, { recursive: true }); await mkdir(indexDir);
  const file = join(root, "file.txt"); await writeFile(file, "data");
  const { sourceVersion } = await authorizeDocumentRead(file, { workspaceRoots: [root], allowedFiles: [] });
  await writeFile(join(indexDir, "index.json"), JSON.stringify({ version: 1, documents: [], failures: [{ path: file, key: sourceVersion, reason: "old failure", reasonCode: "corrupt" }] }));
  let calls = 0;
  const index = new LibraryIndex(indexDir, { getParts: async () => { calls++; return { ok: false, reason: "unsupported" }; } });
  await index.rebuild([root]); await index.rebuild([root]);
  expect(calls).toBe(1);
  const saved = JSON.parse(await readFile(join(indexDir, "index.json"), "utf8"));
  expect(saved.version).toBe(2); expect(saved.failures[0].retryAfter).toBeGreaterThan(saved.failures[0].failedAt);
  expect(JSON.parse(await readFile(join(indexDir, "index.json.bak"), "utf8")).documents).toEqual([]);
});

test("rebuild serves the previous authorized snapshot and root revocation takes effect immediately", async ({}, info) => {
  const root = info.outputPath("root"); await mkdir(root, { recursive: true });
  const file = join(root, "file.txt"); await writeFile(file, "old marker");
  const gate = deferred(); let hold = false;
  const index = new LibraryIndex(info.outputPath("index"), { getParts: async (file) => {
    if (hold) await gate.promise;
    return { unit: "section", parts: [await readFile(file, "utf8")] };
  } });
  let roots = [root];
  const tool = createLibraryRuntimeTools(() => ({ enabled: true, roots }), index)[0]!;
  await index.rebuild(roots);
  hold = true; await writeFile(file, "new marker with changed version");
  const rebuilding = index.rebuild(roots);
  await expect.poll(() => index.status().state).toBe("indexing");
  const during = await tool.execute("during", { query: "old" });
  expect(during.content[0]?.text).toContain("previous committed");
  expect(during.content[0]?.text).toContain("old marker");
  roots = [];
  const switched = index.rebuild(roots);
  expect(index.documents()).toEqual([]);
  expect((await tool.execute("revoked", { query: "old" })).content[0]?.text).not.toContain("old marker");
  gate.resolve(); await Promise.all([rebuilding, switched]);
  expect(index.documents()).toEqual([]);
});

test("offline roots keep dated cached excerpts; reliable scans remove confirmed deletions", async ({}, info) => {
  const root = info.outputPath("root"); await mkdir(root, { recursive: true });
  const file = join(root, "file.txt"); await writeFile(file, "cached marker");
  const index = new LibraryIndex(info.outputPath("index"), { getParts: async (file) => ({ unit: "section", parts: [await readFile(file, "utf8")] }) });
  await index.rebuild([root]);
  const indexedAt = index.documents()[0]?.indexedAt;
  await rename(root, info.outputPath("temporarily-offline"));
  await index.rebuild([root]);
  expect(index.documents()[0]).toMatchObject({ offline: true, indexedAt });
  expect(index.status().roots?.[0]?.state).toBe("offline");
  const [tool] = createLibraryRuntimeTools(() => ({ enabled: true, roots: [root] }), index);
  expect((await tool!.execute("cached", { query: "marker" })).content[0]?.text).toContain("not freshly read");
  await rename(info.outputPath("temporarily-offline"), root);
  await index.rebuild([root]); expect(index.documents()[0]?.offline).toBe(false);
  await rename(file, info.outputPath("retained-file.txt"));
  await index.rebuild([root]); expect(index.documents()).toEqual([]);
});

test("failed snapshot save keeps the previous committed data", async ({}, info) => {
  const root = info.outputPath("root"); await mkdir(root, { recursive: true });
  const file = join(root, "file.txt"); await writeFile(file, "old marker");
  let fail = false;
  const index = new LibraryIndex(info.outputPath("index"), {
    getParts: async (file) => ({ unit: "section", parts: [await readFile(file, "utf8")] }),
    writeIndex: async (...args) => { if (fail) throw new Error("synthetic disk failure"); await writeFileAtomicQueued(...args); },
  });
  await index.rebuild([root]); fail = true; await writeFile(file, "new marker");
  await expect(index.rebuild([root])).rejects.toThrow("synthetic disk failure");
  expect(index.documents()[0]?.parts).toEqual(["old marker"]);
  expect(index.status().snapshotAvailable).toBe(true);
});

test("Clear during an asynchronous save cannot restore old memory or disk contents", async ({}, info) => {
  const root = info.outputPath("root"); await mkdir(root, { recursive: true });
  const file = join(root, "file.txt"); await writeFile(file, "old");
  const gate = deferred(); let hold = false; let writing = false;
  const indexDir = info.outputPath("index");
  const index = new LibraryIndex(indexDir, {
    getParts: async (file) => ({ unit: "section", parts: [await readFile(file, "utf8")] }),
    writeIndex: async (...args) => { if (hold) { writing = true; await gate.promise; } await writeFileAtomicQueued(...args); },
  });
  await index.rebuild([root]); hold = true; await writeFile(file, "new");
  const rebuilding = index.rebuild([root]); await expect.poll(() => writing).toBe(true);
  const clearing = index.clear({ deleteDisk: true });
  expect(index.documents()).toEqual([]); hold = false; gate.resolve();
  await Promise.all([rebuilding, clearing]);
  expect(index.documents()).toEqual([]); expect(index.status().state).toBe("idle");
  expect(JSON.parse(await readFile(join(indexDir, "index.json"), "utf8")).documents).toEqual([]);
});

function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }

test("first offline scan reports not ready instead of no matches", async ({}, info) => {
  const root = info.outputPath("unavailable-root");
  const index = new LibraryIndex(info.outputPath("index"));
  await index.rebuild([root]);
  const [tool] = createLibraryRuntimeTools(() => ({ enabled: true, roots: [root] }), index);
  const result = await tool!.execute("search", { query: "anything" });
  expect(result.content[0]?.text).toContain("not ready");
  expect(result.content[0]?.text).not.toContain("No local library results");
});

test("changing roots during an old save leaves only the new authorized snapshot", async ({}, info) => {
  const rootA = info.outputPath("a"); const rootB = info.outputPath("b");
  await mkdir(rootA, { recursive: true }); await mkdir(rootB);
  await writeFile(join(rootA, "a.txt"), "secret A"); await writeFile(join(rootB, "b.txt"), "allowed B");
  const gate = deferred(); let block = true; let writing = false;
  const indexDir = info.outputPath("index");
  const index = new LibraryIndex(indexDir, {
    getParts: async (file) => ({ unit: "section", parts: [await readFile(file, "utf8")] }),
    writeIndex: async (...args) => { if (block) { writing = true; await gate.promise; } await writeFileAtomicQueued(...args); },
  });
  const a = index.rebuild([rootA]); await expect.poll(() => writing).toBe(true);
  const b = index.rebuild([rootB]);
  expect(index.documents()).toEqual([]);
  block = false; gate.resolve(); await Promise.all([a, b]);
  expect(index.documents().map((doc) => doc.title)).toEqual(["b"]);
  expect(JSON.parse(await readFile(join(indexDir, "index.json"), "utf8")).documents.map((doc: any) => doc.title)).toEqual(["b"]);
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
  await expect(readFile(indexPath, "utf8")).resolves.toContain('"version":2');

  await index.clear({ deleteDisk: true });
  expect(index.documents()).toEqual([]);
  expect(index.status()).toMatchObject({ state: "idle", documents: 0, parts: 0 });
  expect(JSON.parse(await readFile(indexPath, "utf8")).documents).toEqual([]);
});
