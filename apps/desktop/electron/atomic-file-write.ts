import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const operationQueue = new Map<string, Promise<unknown>>();
const RETRY_DELAYS_MS = [25, 50, 100, 200, 400] as const;

/** Filesystem boundary shared by production writes and fault-injection tests. */
export type AtomicFileIO = Pick<typeof fs, "mkdir" | "open" | "readFile" | "rename" | "unlink">;

/**
 * Stage and sync valid JSON, then atomically replace the primary. A valid old
 * primary is staged separately as the backup. Failed renames never unlink the
 * destination: either the old primary or the last good backup remains readable.
 */
export async function writeFileAtomicQueued(
  filePath: string,
  contents: string,
  io: AtomicFileIO = fs,
): Promise<void> {
  await serialize(filePath, async () => {
    JSON.parse(contents);
    const dir = dirname(filePath);
    await io.mkdir(dir, { recursive: true });
    const tempPath = siblingPath(filePath, "tmp");
    try {
      await writeSynced(tempPath, contents, io);
      await refreshBackup(filePath, io);
      await withRetry(() => io.rename(tempPath, filePath));
    } catch (error) {
      await cleanup(tempPath, io);
      throw error;
    }
    await syncDirectory(dir, io);
  });
}

export interface AtomicReadResult<T> {
  readonly value: T | undefined;
  readonly corrupted: boolean;
  readonly recovered: boolean;
}

/** Recovery is queued with writes so it cannot quarantine a newly saved primary. */
export async function readJsonWithBackup<T>(
  filePath: string,
  io: AtomicFileIO = fs,
): Promise<AtomicReadResult<T>> {
  return serialize(filePath, async () => {
    const primary = await readJson<T>(filePath, io);
    if (primary.status === "ok") {
      return { value: primary.value, corrupted: false, recovered: false };
    }
    const backup = await readJson<T>(filePath + ".bak", io);
    if (backup.status === "ok") {
      if (primary.status === "corrupt") {
        const quarantine = siblingPath(filePath, "corrupt");
        try {
          // Unique names retain previous corruption evidence, including long names.
          await withRetry(() => io.rename(filePath, quarantine));
        } catch (error) {
          console.warn("[atomic-file-write] could not isolate " + filePath, error);
        }
      }
      return { value: backup.value, corrupted: primary.status !== "missing", recovered: true };
    }
    return { value: undefined, corrupted: primary.status !== "missing", recovered: false };
  });
}

type JsonRead<T> =
  | { status: "ok"; value: T; raw: string }
  | { status: "missing" | "unreadable" | "corrupt" };

async function readJson<T>(filePath: string, io: AtomicFileIO): Promise<JsonRead<T>> {
  let raw: string;
  try {
    raw = await withRetry(() => io.readFile(filePath, "utf8"));
  } catch (error) {
    return { status: errorCode(error) === "ENOENT" ? "missing" : "unreadable" };
  }
  try {
    return { status: "ok", value: JSON.parse(raw) as T, raw };
  } catch {
    return { status: "corrupt" };
  }
}

async function refreshBackup(filePath: string, io: AtomicFileIO): Promise<void> {
  const primary = await readJson<unknown>(filePath, io);
  if (primary.status !== "ok") return;

  const backupPath = filePath + ".bak";
  const stagePath = siblingPath(backupPath, "tmp");
  try {
    await writeSynced(stagePath, primary.raw, io);
    await withRetry(() => io.rename(stagePath, backupPath));
  } catch (error) {
    // The primary has not moved and the previous backup has not been truncated.
    await cleanup(stagePath, io);
    console.warn("[atomic-file-write] could not refresh backup " + backupPath, error);
  }
}

function siblingPath(filePath: string, extension: "tmp" | "corrupt"): string {
  return join(dirname(filePath), "." + basename(filePath).slice(0, 24) + "." + randomUUID() + "." + extension);
}

async function writeSynced(filePath: string, contents: string, io: AtomicFileIO): Promise<void> {
  const handle = await io.open(filePath, "wx");
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function withRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !["EPERM", "EACCES", "EBUSY", "ENOTEMPTY"].includes(errorCode(error) ?? "")) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

async function syncDirectory(dir: string, io: AtomicFileIO): Promise<void> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await io.open(dir, "r");
    await handle.sync();
  } catch {
    // Windows may not support directory fsync. The file replacement still succeeded.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function cleanup(filePath: string, io: AtomicFileIO): Promise<void> {
  try {
    await io.unlink(filePath);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      console.warn("[atomic-file-write] could not remove temporary file " + filePath, error);
    }
  }
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

async function serialize<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const previous = operationQueue.get(filePath) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  operationQueue.set(filePath, next);
  try {
    return await next;
  } finally {
    if (operationQueue.get(filePath) === next) operationQueue.delete(filePath);
  }
}
