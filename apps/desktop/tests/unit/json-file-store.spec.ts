import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { JsonFileStore } from "../../electron/json-file-store";

/**
 * Session keys embed the whole workspace path, so a Chinese path used to blow
 * past the 255-character limit on one path component once percent-encoded —
 * attachments for those workspaces could not be saved at all. These cover the
 * hashed naming that fixed it, and the migration that keeps already-saved
 * attachments visible after the upgrade.
 */

interface Attachment {
  readonly id: string;
  readonly name: string;
}

const DEEP_CHINESE_WORKSPACE = "C:\\Users\\张三\\Documents\\工程资料\\项目审查\\系统开发\\需求文档\\技术方案";
const SESSION_ID = "0f9c3b21-4d7e-4a52-9d1a-6c8b7e5f2a13";
const KEY = `${DEEP_CHINESE_WORKSPACE}:${SESSION_ID}`;

test("a deep Chinese workspace path round-trips instead of overflowing the file name", async ({}, testInfo) => {
  const userData = testInfo.outputPath("attachments-cjk");
  await mkdir(userData, { recursive: true });
  const store = new JsonFileStore<Attachment[]>(userData, "attachments");

  const attachments: Attachment[] = [{ id: "a1", name: "招标文件.docx" }];
  await store.write(KEY, attachments);

  expect(await store.read(KEY)).toEqual(attachments);
  expect(await store.listKeys()).toEqual([KEY]);

  const names = await readdir(join(userData, "attachments"));
  for (const name of names) {
    expect(name.length, `${name} must fit in one path component`).toBeLessThanOrEqual(255);
  }
  // The old scheme would have produced a ~284-character name for this key.
  expect(encodeURIComponent(KEY).length).toBeGreaterThan(255);
});

test("keys stay isolated from each other", async ({}, testInfo) => {
  const userData = testInfo.outputPath("attachments-isolation");
  await mkdir(userData, { recursive: true });
  const store = new JsonFileStore<Attachment[]>(userData, "attachments");

  await store.write(`${KEY}-one`, [{ id: "1", name: "一.docx" }]);
  await store.write(`${KEY}-two`, [{ id: "2", name: "二.docx" }]);

  expect(await store.read(`${KEY}-one`)).toEqual([{ id: "1", name: "一.docx" }]);
  expect(await store.read(`${KEY}-two`)).toEqual([{ id: "2", name: "二.docx" }]);
  expect((await store.listKeys()).sort()).toEqual([`${KEY}-one`, `${KEY}-two`].sort());
});

test("attachments saved under the pre-hash file name survive the upgrade", async ({}, testInfo) => {
  const userData = testInfo.outputPath("attachments-migration");
  const storeDir = join(userData, "attachments");
  await mkdir(storeDir, { recursive: true });

  // A short key, which is what the old naming scheme could actually write.
  const legacyKey = "C:\\work:legacy-session";
  const legacyPath = join(storeDir, `${encodeURIComponent(legacyKey)}.json`);
  const legacyValue: Attachment[] = [{ id: "old", name: "旧附件.pdf" }];
  await writeFile(legacyPath, JSON.stringify(legacyValue), "utf8");

  const store = new JsonFileStore<Attachment[]>(userData, "attachments");
  expect(await store.read(legacyKey)).toEqual(legacyValue);
  // Reading needs no write access. The next successful save archives the old bytes.
  expect(await readFile(legacyPath, "utf8")).toBe(JSON.stringify(legacyValue));
  await store.write(legacyKey, legacyValue);
  await expect(readFile(legacyPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  expect(await store.read(legacyKey)).toEqual(legacyValue);
  expect(await store.listKeys()).toEqual([legacyKey]);
  const archived = (await readdir(storeDir)).filter((name) => name.endsWith(".legacy"));
  expect(archived).toHaveLength(1);
  expect(JSON.parse(await readFile(join(storeDir, archived[0]!), "utf8"))).toEqual(legacyValue);
});

test("listKeys reports pre-hash and hashed entries together, skipping unreadable files", async ({}, testInfo) => {
  const userData = testInfo.outputPath("attachments-listing");
  const storeDir = join(userData, "attachments");
  await mkdir(storeDir, { recursive: true });
  await writeFile(join(storeDir, `${encodeURIComponent("C:\\work:legacy")}.json`), "[]", "utf8");
  await writeFile(join(storeDir, `${"0".repeat(64)}.json`), "{ truncated", "utf8");

  const store = new JsonFileStore<Attachment[]>(userData, "attachments");
  await store.write("C:\\work:hashed", [{ id: "h", name: "新附件.xlsx" }]);

  // The unreadable hashed file is skipped rather than guessed at: callers use
  // this list to decide what to delete.
  expect((await store.listKeys()).sort()).toEqual(["C:\\work:hashed", "C:\\work:legacy"]);
});

test("remove clears the entry, its backup and any pre-hash leftovers", async ({}, testInfo) => {
  const userData = testInfo.outputPath("attachments-remove");
  const storeDir = join(userData, "attachments");
  await mkdir(storeDir, { recursive: true });
  const store = new JsonFileStore<Attachment[]>(userData, "attachments");

  await store.write(KEY, [{ id: "a", name: "甲.docx" }]);
  await store.write(KEY, [{ id: "b", name: "乙.docx" }]);
  await writeFile(join(storeDir, `${encodeURIComponent("C:\\work:legacy")}.json`), "[]", "utf8");

  await store.remove(KEY);
  await store.remove("C:\\work:legacy");

  expect(await store.read(KEY)).toBeUndefined();
  expect(await readdir(storeDir)).toEqual([]);
});

test("backup-only entries remain listed and recover after reopening the store", async ({}, testInfo) => {
  const userData = testInfo.outputPath("backup-only");
  const store = new JsonFileStore<Attachment[]>(userData, "attachments");
  const data = [{ id: "saved", name: "恢复附件.pdf" }];
  await store.write(KEY, data);
  const target = join(userData, "attachments", `${createHash("sha256").update(KEY).digest("hex")}.json`);
  await rename(target, `${target}.bak`);

  const reopened = new JsonFileStore<Attachment[]>(userData, "attachments");
  expect(await reopened.listKeys()).toEqual([KEY]);
  expect(await reopened.read(KEY)).toEqual(data);
});

test("a failed migration leaves the legacy attachment record readable", async ({}, testInfo) => {
  const userData = testInfo.outputPath("failed-migration");
  const root = join(userData, "attachments");
  const key = "C:\\work:legacy-session";
  const target = join(root, `${createHash("sha256").update(key).digest("hex")}.json`);
  await mkdir(target, { recursive: true });
  const oldData = [{ id: "old", name: "old.pdf" }];
  const legacy = join(root, `${encodeURIComponent(key)}.json`);
  await writeFile(legacy, JSON.stringify(oldData));
  const store = new JsonFileStore<Attachment[]>(userData, "attachments");
  expect(await store.read(key)).toEqual(oldData);
  await expect(store.write(key, [{ id: "new", name: "new.pdf" }])).rejects.toThrow();
  expect(await store.read(key)).toEqual(oldData);
  expect(JSON.parse(await readFile(legacy, "utf8"))).toEqual(oldData);
});

test("an envelope with another session's key is never returned or listed", async ({}, testInfo) => {
  const userData = testInfo.outputPath("wrong-key");
  const root = join(userData, "attachments");
  await mkdir(root, { recursive: true });
  const target = join(root, `${createHash("sha256").update(KEY).digest("hex")}.json`);
  await writeFile(target, JSON.stringify({ version: 1, key: "other-session", data: [{ id: "other" }] }));
  const store = new JsonFileStore<Attachment[]>(userData, "attachments");
  expect(await store.read(KEY)).toBeUndefined();
  expect(await store.listKeys()).toEqual([]);
});
