import { unzipSync, type UnzipFileInfo } from "fflate";
import { MAX_DOCUMENT_BYTES } from "./document-limits";

export class DocumentZipError extends Error {
  constructor(readonly reason: "corrupt" | "too-large" | "password-protected" | "unsupported", message: string) { super(message); }
}
export const DOCUMENT_ZIP_LIMITS = {
  entries: 4_096, entryBytes: 32 * 1024 * 1024,
  expandedBytes: 64 * 1024 * 1024, compressionRatio: 1_000,
};

/** fflate's filter walks the central directory without inflating any members.
 * Check container/encryption headers first because its public metadata omits
 * encryption flags. ZIP64/multi-volume containers are explicitly unsupported. */
export function inspectDocumentZip(bytes: Uint8Array): ReadonlyMap<string, UnzipFileInfo> {
  if (bytes.length > MAX_DOCUMENT_BYTES) throw new DocumentZipError("too-large", "ZIP input byte limit exceeded.");
  checkDirectoryHeaders(bytes);
  const entries = new Map<string, UnzipFileInfo>();
  let expanded = 0;
  try {
    unzipSync(bytes, { filter: (entry) => {
      expanded += entry.originalSize;
      if (entries.size >= DOCUMENT_ZIP_LIMITS.entries || entry.originalSize > DOCUMENT_ZIP_LIMITS.entryBytes ||
          expanded > DOCUMENT_ZIP_LIMITS.expandedBytes || entry.originalSize / Math.max(1, entry.size) > DOCUMENT_ZIP_LIMITS.compressionRatio) {
        throw new DocumentZipError("too-large", "Office ZIP exceeds entry, decompression or compression ratio limits.");
      }
      if (entries.has(entry.name)) throw new DocumentZipError("corrupt", "Duplicate ZIP member.");
      entries.set(entry.name, entry);
      return false;
    } });
  } catch (error) {
    if (error instanceof DocumentZipError) throw error;
    throw new DocumentZipError("corrupt", "Invalid ZIP central directory.");
  }
  return entries;
}

export function readDocumentZipParts(bytes: Uint8Array, include: (name: string) => boolean): Record<string, Uint8Array> {
  inspectDocumentZip(bytes);
  try { return unzipSync(bytes, { filter: (entry) => include(entry.name) }); }
  catch { throw new DocumentZipError("corrupt", "Office ZIP decompression failed."); }
}

function checkDirectoryHeaders(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset--) {
    if (view.getUint32(offset, true) === 0x06054b50 && offset + 22 + view.getUint16(offset + 20, true) === bytes.length) { end = offset; break; }
  }
  if (end < 0) throw new DocumentZipError("corrupt", "ZIP end directory missing.");
  const count = view.getUint16(end + 10, true);
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || view.getUint16(end + 8, true) !== count) {
    throw new DocumentZipError("unsupported", "Multi-volume ZIP is unsupported.");
  }
  if (count > DOCUMENT_ZIP_LIMITS.entries) throw new DocumentZipError("too-large", "Too many Office ZIP entries.");
  let offset = view.getUint32(end + 16, true);
  const directoryEnd = offset + view.getUint32(end + 12, true);
  if (directoryEnd > end) throw new DocumentZipError("corrupt", "Invalid ZIP directory bounds.");
  for (let index = 0; index < count; index++) {
    if (offset + 46 > directoryEnd || view.getUint32(offset, true) !== 0x02014b50) throw new DocumentZipError("corrupt", "Invalid ZIP member header.");
    if (view.getUint16(offset + 8, true) & 1) throw new DocumentZipError("password-protected", "Encrypted Office ZIP is unsupported.");
    const method = view.getUint16(offset + 10, true);
    if (method !== 0 && method !== 8) throw new DocumentZipError("unsupported", "Unsupported ZIP compression method.");
    const local = view.getUint32(offset + 42, true);
    if (local + 30 > offset || view.getUint32(local, true) !== 0x04034b50) throw new DocumentZipError("corrupt", "Invalid ZIP local header.");
    if (view.getUint16(local + 6, true) & 1) throw new DocumentZipError("password-protected", "Encrypted Office ZIP is unsupported.");
    const dataStart = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    if (dataStart + view.getUint32(offset + 20, true) > view.getUint32(end + 16, true)) throw new DocumentZipError("corrupt", "Invalid ZIP member bounds.");
    offset += 46 + view.getUint16(offset + 28, true) + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
  if (offset !== directoryEnd) throw new DocumentZipError("corrupt", "ZIP directory length mismatch.");
}
