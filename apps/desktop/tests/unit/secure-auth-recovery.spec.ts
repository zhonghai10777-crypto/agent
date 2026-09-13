import type { SafeStorage } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { SecureAuthStorageBackend } from "../../electron/secure-auth-backend";

const credential = { type: "api_key" as const, key: "synthetic-key-only" };
const encrypted = (value: unknown) => Buffer.from(`cipher:${JSON.stringify(value)}`).toString("base64");

function storage(options: { locked?: boolean; failEncryption?: boolean } = {}): SafeStorage {
  return {
    isEncryptionAvailable: () => !options.locked,
    getSelectedStorageBackend: () => "keychain",
    encryptString: (value: string) => {
      if (options.failEncryption) throw new Error("Synthetic encryption failure");
      return Buffer.from(`cipher:${value}`);
    },
    decryptString: (bytes: Buffer) => {
      const value = bytes.toString();
      if (!value.startsWith("cipher:")) throw new Error("Synthetic decryption failure");
      return value.slice(7);
    },
  } as unknown as SafeStorage;
}

test("undecryptable entries prevent migration from replacing any original ciphertext", async ({}, info) => {
  const dir = info.outputPath("synthetic-auth"); await mkdir(dir, { recursive: true });
  const keys = join(dir, "secure-keys.json"), auth = join(dir, "auth.json");
  const original = JSON.stringify({ valid: encrypted(credential), locked: Buffer.from("other-keychain-ciphertext").toString("base64") });
  const legacy = JSON.stringify({ added: credential });
  await writeFile(keys, original); await writeFile(auth, legacy);
  const backend = new SecureAuthStorageBackend(storage(), keys, auth);
  expect(await backend.read("valid")).toEqual(credential);
  expect(() => backend.migratePlaintextKeys()).toThrow(/No credentials were overwritten/);
  expect(await readFile(keys, "utf8")).toBe(original);
  expect(await readFile(auth, "utf8")).toBe(legacy);
});

test("corrupt or locked encrypted storage cannot be cleared by an empty store update", async ({}, info) => {
  const dir = info.outputPath("synthetic-auth"); await mkdir(dir, { recursive: true });
  for (const [name, content, locked] of [["corrupt", "{broken", false], ["locked", JSON.stringify({ saved: encrypted(credential) }), true]] as const) {
    const path = join(dir, `${name}.json`); await writeFile(path, content);
    const backend = new SecureAuthStorageBackend(storage({ locked }), path, join(dir, "auth.json"));
    await expect(backend.delete("unrelated")).rejects.toThrow(/No credentials were overwritten/);
    expect(await readFile(path, "utf8")).toBe(content);
  }
});

test("failed encryption preserves both stores and migration succeeds idempotently after recovery", async ({}, info) => {
  const dir = info.outputPath("synthetic-auth"); await mkdir(dir, { recursive: true });
  const keys = join(dir, "secure-keys.json"), auth = join(dir, "auth.json");
  const original = JSON.stringify({ saved: encrypted(credential) }), legacy = JSON.stringify({ added: credential });
  await writeFile(keys, original); await writeFile(auth, legacy);
  const options = { failEncryption: true };
  const backend = new SecureAuthStorageBackend(storage(options), keys, auth);
  expect(() => backend.migratePlaintextKeys()).toThrow("Synthetic encryption failure");
  expect(await readFile(keys, "utf8")).toBe(original);
  expect(await readFile(auth, "utf8")).toBe(legacy);
  options.failEncryption = false;
  expect(backend.migratePlaintextKeys()).toBe(1);
  const after = await readFile(keys, "utf8");
  expect(backend.migratePlaintextKeys()).toBe(0);
  expect(await readFile(keys, "utf8")).toBe(after);
  expect(await backend.read("saved")).toEqual(credential);
  expect(await backend.read("added")).toEqual(credential);
  await backend.delete("added");
  expect(await backend.read("added")).toBeUndefined();
  expect(await backend.read("saved")).toEqual(credential);
});
