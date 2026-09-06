import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { readJsonWithBackup, writeFileAtomicQueued, type AtomicFileIO } from "../../electron/atomic-file-write";

/**
 * The failure these cover: a corrupt primary file plus a good `.bak` used to
 * lose *both* copies. The old write order moved the primary onto the backup
 * first, so the corrupt bytes overwrote the last good version, and a write that
 * then failed left nothing readable at all. ui-state carries drafts, pins and
 * workspace order, so that is real user data.
 */

async function dir(testInfo: { outputPath: (name: string) => string }, name: string): Promise<string> {
  const root = testInfo.outputPath(name);
  await mkdir(root, { recursive: true });
  return root;
}

test("a corrupt primary never overwrites a good backup", async ({}, testInfo) => {
  const root = await dir(testInfo, "backup-guard");
  const target = join(root, "ui-state.json");

  await writeFileAtomicQueued(target, JSON.stringify({ generation: 1 }));
  await writeFileAtomicQueued(target, JSON.stringify({ generation: 2 }));
  expect(JSON.parse(await readFile(`${target}.bak`, "utf8"))).toEqual({ generation: 1 });

  // Simulate the crash-truncated primary the recovery path exists for.
  await writeFile(target, "{ truncated", "utf8");
  await writeFileAtomicQueued(target, JSON.stringify({ generation: 3 }));

  expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ generation: 3 });
  expect(JSON.parse(await readFile(`${target}.bak`, "utf8"))).toEqual({ generation: 1 });
});

test("recovering from a backup moves the corrupt primary aside so it stops shadowing it", async ({}, testInfo) => {
  const root = await dir(testInfo, "corrupt-isolation");
  const target = join(root, "ui-state.json");

  await writeFileAtomicQueued(target, JSON.stringify({ pinned: ["a"] }));
  await writeFileAtomicQueued(target, JSON.stringify({ pinned: ["a", "b"] }));
  await writeFile(target, "not json at all", "utf8");

  const recovered = await readJsonWithBackup<{ pinned: string[] }>(target);
  expect(recovered.value).toEqual({ pinned: ["a"] });
  expect(recovered.recovered).toBe(true);
  expect(recovered.corrupted).toBe(true);

  const [quarantined] = (await readdir(root)).filter((name) => name.endsWith(".corrupt"));
  expect(quarantined).toBeTruthy();
  expect(await readFile(join(root, quarantined!), "utf8")).toBe("not json at all");
  // With the corrupt primary isolated, the recovered value is what a plain read
  // returns from now on — no "corrupt ui-state" on every launch.
  const second = await readJsonWithBackup<{ pinned: string[] }>(target);
  expect(second.value).toEqual({ pinned: ["a"] });
});

test("a missing primary with no backup is the first-run case, not corruption", async ({}, testInfo) => {
  const root = await dir(testInfo, "first-run");
  const result = await readJsonWithBackup(join(root, "ui-state.json"));
  expect(result).toEqual({ value: undefined, corrupted: false, recovered: false });
});

test("temp file names stay inside the 255-character limit for a long CJK target", async ({}, testInfo) => {
  const root = await dir(testInfo, "long-name");
  // Fits both NTFS's character limit and POSIX's byte limit, unlike the old temp name.
  const target = join(root, `${"报".repeat(70)}${"a".repeat(30)}.json`);

  await writeFileAtomicQueued(target, JSON.stringify({ ok: true }));
  expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ ok: true });
  for (const name of await readdir(root)) {
    expect(name.length, `${name} must fit in one path component`).toBeLessThanOrEqual(255);
  }
});

const injectedError = () => Object.assign(new Error("injected disk failure"), { code: "EIO" });

for (const fault of [
  "primary-open", "primary-writeFile", "primary-sync", "primary-close",
  "backup-open", "backup-writeFile", "backup-sync", "backup-rename", "promote",
]) {
  test(`a failure at ${fault} preserves a readable copy`, async ({}, testInfo) => {
    const root = await dir(testInfo, fault);
    const target = join(root, "ui-state.json");
    await writeFileAtomicQueued(target, JSON.stringify({ generation: 1 }));
    await writeFileAtomicQueued(target, JSON.stringify({ generation: 2 }));
    const unlinked: string[] = [];
    const io: AtomicFileIO = {
      ...fs,
      async open(filePath, flags, mode) {
        const stage = String(filePath).includes(".bak.") ? "backup" : "primary";
        if (flags === "wx" && fault === `${stage}-open`) throw injectedError();
        const handle = await fs.open(filePath, flags, mode);
        if (flags !== "wx") return handle;
        return new Proxy(handle, {
          get(file, property) {
            const value = Reflect.get(file, property, file);
            if (typeof value !== "function") return value;
            return async (...args: unknown[]) => {
              if (fault === `${stage}-${String(property)}`) {
                if (property === "close") await file.close();
                throw injectedError();
              }
              return value.apply(file, args);
            };
          },
        });
      },
      async rename(from, to) {
        if ((fault === "promote" && to === target) || (fault === "backup-rename" && to === `${target}.bak`)) {
          throw injectedError();
        }
        await fs.rename(from, to);
      },
      async unlink(filePath) {
        unlinked.push(String(filePath));
        await fs.unlink(filePath);
      },
    };
    const save = writeFileAtomicQueued(target, JSON.stringify({ generation: 3 }), io);
    if (fault.startsWith("backup-")) await save;
    else await expect(save).rejects.toMatchObject({ code: "EIO" });

    const result = await readJsonWithBackup<{ generation: number }>(target);
    expect(result.value?.generation).toBe(fault.startsWith("backup-") ? 3 : 2);
    expect(unlinked).not.toContain(target);
    expect(unlinked).not.toContain(`${target}.bak`);
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
}

test("backup recovery followed by failed promotion retains the recovered state", async ({}, testInfo) => {
  const root = await dir(testInfo, "recover-then-fail");
  const target = join(root, "ui-state.json");
  await writeFile(`${target}.bak`, JSON.stringify({ draft: "有效草稿" }));
  await writeFile(target, "{ corrupt");
  expect((await readJsonWithBackup(target)).recovered).toBe(true);
  await expect(writeFileAtomicQueued(target, JSON.stringify({ draft: "new" }), {
    ...fs,
    async rename(from, to) {
      if (to === target) throw injectedError();
      await fs.rename(from, to);
    },
  })).rejects.toMatchObject({ code: "EIO" });
  expect((await readJsonWithBackup(target)).value).toEqual({ draft: "有效草稿" });
});

test("exhausted sharing retries never delete the primary even when backup refresh failed", async ({}, testInfo) => {
  const root = await dir(testInfo, "sharing-lock");
  const target = join(root, "ui-state.json");
  await writeFile(target, JSON.stringify({ draft: "only valid copy" }));
  let attempts = 0;
  await expect(writeFileAtomicQueued(target, JSON.stringify({ draft: "new" }), {
    ...fs,
    async rename(_from, to) {
      if (to === target) attempts += 1;
      throw Object.assign(new Error("locked"), { code: "EPERM" });
    },
  })).rejects.toMatchObject({ code: "EPERM" });
  expect(attempts).toBe(6);
  expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ draft: "only valid copy" });
});

test("a short sharing lock is retried and new writes recover after an earlier failure", async ({}, testInfo) => {
  const root = await dir(testInfo, "retry");
  const target = join(root, "ui-state.json");
  let attempts = 0;
  await writeFileAtomicQueued(target, JSON.stringify({ ok: true }), {
    ...fs,
    async rename(from, to) {
      if (to === target && attempts++ === 0) throw Object.assign(new Error("busy"), { code: "EBUSY" });
      await fs.rename(from, to);
    },
  });
  expect(attempts).toBe(2);
  await expect(writeFileAtomicQueued(target, "invalid JSON")).rejects.toThrow();
  await writeFileAtomicQueued(target, JSON.stringify({ ok: "next" }));
  expect((await readJsonWithBackup(target)).value).toEqual({ ok: "next" });
});

test("quarantine keeps evidence from multiple corrupt generations", async ({}, testInfo) => {
  const root = await dir(testInfo, "quarantine-history");
  const target = join(root, "ui-state.json");
  await writeFile(`${target}.bak`, JSON.stringify({ ok: true }));
  for (const bad of ["broken one", "broken two"]) {
    await writeFile(target, bad);
    expect((await readJsonWithBackup(target)).value).toEqual({ ok: true });
  }
  const evidence = (await readdir(root)).filter((name) => name.endsWith(".corrupt"));
  expect(evidence).toHaveLength(2);
  expect((await Promise.all(evidence.map((name) => readFile(join(root, name), "utf8")))).sort()).toEqual(["broken one", "broken two"]);
});

test("queued writes to one path apply in order and leave no temp files behind", async ({}, testInfo) => {
  const root = await dir(testInfo, "queued");
  const target = join(root, "ui-state.json");

  await Promise.all(
    [1, 2, 3, 4, 5].map((generation) => writeFileAtomicQueued(target, JSON.stringify({ generation }))),
  );

  expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ generation: 5 });
  expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});
