import { readFile, stat } from "node:fs/promises";
import { extractDocument, type DocumentExtraction } from "./document-extract";

/**
 * Extraction results, cached per file version.
 *
 * A document is parsed twice on the normal path — once when it is attached, to
 * show the page count on the chip and surface failures before the user hits
 * send, and again when the message is submitted, to inline short documents into
 * the prompt. Caching keeps the second one free, and keeps `read_document`
 * from re-parsing a 300-page standard on every page turn.
 *
 * The key includes mtime and size so editing a file in place invalidates it.
 */

interface CacheEntry {
  readonly key: string;
  readonly extraction: DocumentExtraction;
}

/** Bounded by total extracted characters rather than entry count. */
const MAX_CACHED_CHARS = 4_000_000;

const cache = new Map<string, CacheEntry>();
let cachedChars = 0;

export async function getDocumentExtraction(fsPath: string): Promise<DocumentExtraction> {
  let key: string;
  try {
    const stats = await stat(fsPath);
    key = `${fsPath}:${stats.mtimeMs}:${stats.size}`;
  } catch (error) {
    return { ok: false, kind: "unknown", reason: "corrupt", detail: errorMessage(error) };
  }

  const hit = cache.get(fsPath);
  if (hit?.key === key) {
    // Refresh recency so the eviction below drops the least recently used file.
    cache.delete(fsPath);
    cache.set(fsPath, hit);
    return hit.extraction;
  }

  let extraction: DocumentExtraction;
  try {
    extraction = await extractDocument(new Uint8Array(await readFile(fsPath)), fsPath);
  } catch (error) {
    extraction = { ok: false, kind: "unknown", reason: "corrupt", detail: errorMessage(error) };
  }

  if (hit) {
    cachedChars -= hit.extraction.ok ? hit.extraction.chars : 0;
    cache.delete(fsPath);
  }
  cache.set(fsPath, { key, extraction });
  cachedChars += extraction.ok ? extraction.chars : 0;
  evict();
  return extraction;
}

function evict(): void {
  for (const [path, entry] of cache) {
    if (cachedChars <= MAX_CACHED_CHARS || cache.size <= 1) {
      return;
    }
    cache.delete(path);
    cachedChars -= entry.extraction.ok ? entry.extraction.chars : 0;
  }
}

/** Test seam: drops every cached extraction. */
export function resetDocumentExtractionCache(): void {
  cache.clear();
  cachedChars = 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
