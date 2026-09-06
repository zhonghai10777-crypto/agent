import { createHash, randomUUID } from "node:crypto";
import { readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { readJsonWithBackup, writeFileAtomicQueued } from "./atomic-file-write";

interface StoredEnvelope<T> {
  readonly version: 1;
  readonly key: string;
  readonly data: T;
}

const HASHED_NAME_PATTERN = /^[0-9a-f]{64}\.json$/;

/**
 * Fixed-length filenames keep workspace paths out of filesystem name limits.
 * Legacy entries remain readable and are archived after their next successful
 * save. Reading a legacy entry alone never requires a write to succeed.
 */
export class JsonFileStore<T> {
  private readonly rootDir: string;

  constructor(userDataDir: string, subdir: string) {
    this.rootDir = join(userDataDir, subdir);
  }

  async read(sessionKey: string): Promise<T | undefined> {
    const hashed = await readJsonWithBackup<StoredEnvelope<T>>(this.filePath(sessionKey));
    if (hashed.value !== undefined) {
      if (isEnvelope<T>(hashed.value) && hashed.value.key === sessionKey) return hashed.value.data;
      console.error("[json-file-store] invalid envelope for " + sessionKey);
      return undefined;
    }
    const legacyPath = this.legacyFilePath(sessionKey);
    return legacyPath ? (await readJsonWithBackup<T>(legacyPath)).value : undefined;
  }

  async write(sessionKey: string, data: T): Promise<void> {
    const envelope: StoredEnvelope<T> = { version: 1, key: sessionKey, data };
    await writeFileAtomicQueued(this.filePath(sessionKey), JSON.stringify(envelope, null, 2) + "\n");
    await this.archiveLegacyFiles(sessionKey);
  }

  async listKeys(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(this.rootDir);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }

    // A backup may be the only surviving copy after recovery or a failed save.
    const names = new Set(entries
      .filter((name) => name.endsWith(".json") || name.endsWith(".json.bak"))
      .map((name) => name.endsWith(".bak") ? name.slice(0, -4) : name));
    const keys = new Set<string>();
    for (const name of names) {
      if (HASHED_NAME_PATTERN.test(name)) {
        const { value } = await readJsonWithBackup<StoredEnvelope<T>>(join(this.rootDir, name));
        if (isEnvelope<T>(value) && this.filePath(value.key) === join(this.rootDir, name)) {
          keys.add(value.key);
        }
      } else {
        try {
          keys.add(decodeURIComponent(name.slice(0, -5)));
        } catch {
          console.warn("[json-file-store] skipping malformed filename " + name);
        }
      }
    }
    return [...keys];
  }

  async remove(sessionKey: string): Promise<void> {
    for (const filePath of [this.filePath(sessionKey), this.legacyFilePath(sessionKey)]) {
      if (!filePath) continue;
      for (const suffix of ["", ".bak"]) {
        try {
          await unlink(filePath + suffix);
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
      }
    }
  }

  private async archiveLegacyFiles(sessionKey: string): Promise<void> {
    const legacy = this.legacyFilePath(sessionKey);
    if (!legacy) return;
    for (const suffix of ["", ".bak"]) {
      try {
        const archive = join(this.rootDir, hashKey(sessionKey) + "." + randomUUID() + ".legacy");
        await rename(legacy + suffix, archive);
      } catch (error) {
        if (!isMissing(error)) {
          // Publication already succeeded. Retain a locked legacy file for recovery.
          console.warn("[json-file-store] could not archive legacy entry " + legacy, error);
        }
      }
    }
  }

  private filePath(sessionKey: string): string {
    return join(this.rootDir, hashKey(sessionKey) + ".json");
  }

  private legacyFilePath(sessionKey: string): string | undefined {
    const name = encodeURIComponent(sessionKey) + ".json";
    // Percent encoding is ASCII; this also avoids probing impossible Windows names.
    return name.length <= 255 ? join(this.rootDir, name) : undefined;
  }
}

function hashKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

function isEnvelope<T>(value: unknown): value is StoredEnvelope<T> {
  return typeof value === "object" && value !== null &&
    (value as StoredEnvelope<T>).version === 1 &&
    typeof (value as StoredEnvelope<T>).key === "string" &&
    Object.hasOwn(value, "data");
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}
