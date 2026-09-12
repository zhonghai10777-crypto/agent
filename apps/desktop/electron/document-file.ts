import { open } from "node:fs/promises";
import type { Stats } from "node:fs";
import { MAX_DOCUMENT_BYTES } from "./document-limits";

export function documentVersion(filePath: string, info: Stats): string {
  return `${filePath}:${info.mtimeMs}:${info.size}:${info.dev}:${info.ino}:${info.ctimeMs}`;
}

/** Read a bounded, opened file and check the same version before and after I/O.
 * Pins the handle even if a pathname is replaced while it is being read. */
export async function readDocumentBytes(filePath: string, expectedVersion: string): Promise<Uint8Array> {
  const handle = await open(filePath, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw Object.assign(new Error("Not a regular file"), { code: "DOCUMENT_UNREADABLE" });
    if (info.size > MAX_DOCUMENT_BYTES) throw Object.assign(new Error("Document input byte limit exceeded"), { code: "DOCUMENT_TOO_LARGE" });
    if (documentVersion(filePath, info) !== expectedVersion) throw changed();
    const bytes = new Uint8Array(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset);
      if (!bytesRead) throw changed();
      offset += bytesRead;
    }
    if (documentVersion(filePath, await handle.stat()) !== expectedVersion) throw changed();
    return bytes;
  } finally {
    await handle.close();
  }
}

function changed(): Error {
  return Object.assign(new Error("The document changed while being read. Retry with the current file version."), { code: "DOCUMENT_CHANGED" });
}
