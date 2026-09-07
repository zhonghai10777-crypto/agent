import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { VisionStore } from "../../electron/vision-store";

const ref = { workspaceId: "C:\\Users\\张三\\工程资料\\视觉测试", sessionId: "image-session" };

test("vision records use bounded names, serialize concurrent updates and isolate profiles and sessions", async ({}, info) => {
  const dir = info.outputPath("视觉记录");
  const store = new VisionStore(dir, "test-profile");
  await Promise.all(Array.from({ length: 16 }, (_, index) => store.update(ref, (data) => ({ ...data, submissions: [...data.submissions, { clientMessageId: `message-${index}`, inputDigest: String(index), generation: 0, state: "pending" }] }))));
  expect((await new VisionStore(dir, "test-profile").read(ref))?.submissions).toHaveLength(16);
  expect(await new VisionStore(dir, "other-profile").read(ref)).toBeUndefined();
  expect(await store.read({ ...ref, sessionId: "other-session" })).toBeUndefined();
  const files = await readdir(join(dir, "vision-records"));
  expect(files.every((file) => file.length <= 80 && !file.includes("张三"))).toBe(true);
  const record = await store.read(ref);
  await expect(store.update(ref, () => ({ ...record!, profileScopeId: "other-profile" }))).rejects.toThrow();
  expect(await store.read(ref)).toEqual(record);
});

test("unrecoverable or foreign vision records cannot be silently overwritten", async ({}, info) => {
  const dir = info.outputPath("corrupt-record");
  const folder = join(dir, "vision-records");
  await mkdir(folder, { recursive: true });
  const key = JSON.stringify(["profile", ref.workspaceId, ref.sessionId]);
  const file = join(folder, `${createHash("sha256").update(key).digest("hex")}.json`);
  await writeFile(file, "{broken");
  const store = new VisionStore(dir, "profile");
  await expect(store.read(ref)).rejects.toMatchObject({ code: "VISION_STORAGE" });
  await expect(store.update(ref, (record) => record)).rejects.toMatchObject({ code: "VISION_STORAGE" });
  expect(await readFile(file, "utf8")).toBe("{broken");
});

test("a denied write preserves the last valid evidence record and succeeds after permissions recover", async ({}, info) => {
  test.skip(process.platform === "win32" || process.getuid?.() === 0, "POSIX permissions are verified on the macOS desktop host.");
  const dir = info.outputPath("permission-recovery");
  const store = new VisionStore(dir, "profile");
  const first = await store.update(ref, (data) => data);
  const folder = join(dir, "vision-records");
  await chmod(folder, 0o500);
  try {
    await expect(store.update(ref, (data) => ({ ...data, submissions: [{ clientMessageId: "retry", inputDigest: "digest", generation: 0, state: "pending" }] }))).rejects.toThrow();
    expect(await store.read(ref)).toEqual(first);
  } finally { await chmod(folder, 0o700); }
  await store.update(ref, (data) => ({ ...data, submissions: [{ clientMessageId: "retry", inputDigest: "digest", generation: 0, state: "pending" }] }));
  expect((await store.read(ref))?.submissions).toHaveLength(1);
});
