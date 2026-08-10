import { readFile, stat } from "node:fs/promises";
import {
  extractDocument,
  segmentText,
  type DocumentExtraction,
  type DocumentExtractionFailure,
} from "./document-extract";

/**
 * Extraction results, cached per file version.
 *
 * A document is parsed on three paths — when it is attached (to show the page
 * count and surface failures before the user hits send), when the message is
 * submitted (to inline short documents), and on every read_document call. The
 * last one is why this matters: paging through a 300-page standard would
 * otherwise re-read and re-parse the whole file for each page.
 *
 * The key includes mtime and size so editing a file in place invalidates it.
 */

/** A document split into addressable parts: PDF pages, or text sections. */
export interface DocumentParts {
  readonly unit: "page" | "section";
  readonly parts: readonly string[];
}

interface CacheEntry {
  readonly key: string;
  readonly extraction: DocumentExtraction;
  /** Filled on first read_document call; PDFs need a separate per-page parse. */
  parts?: DocumentParts | DocumentExtractionFailure;
}

/** Bounded by total extracted characters rather than entry count. */
const MAX_CACHED_CHARS = 4_000_000;

const cache = new Map<string, CacheEntry>();
let cachedChars = 0;

export async function getDocumentExtraction(fsPath: string): Promise<DocumentExtraction> {
  return (await load(fsPath)).extraction;
}

/**
 * The document as addressable parts, for read_document. PDFs page natively;
 * everything else is chunked on paragraph boundaries so the tool has the same
 * "fetch part N" shape for every format.
 */
export async function getDocumentParts(fsPath: string): Promise<DocumentParts | DocumentExtractionFailure> {
  const entry = await load(fsPath);
  if (entry.parts) {
    return entry.parts;
  }

  const extraction = entry.extraction;
  if (!extraction.ok) {
    entry.parts = extraction;
    return extraction;
  }

  if (extraction.kind === "pdf") {
    // Kept from the first parse; only a PDF that arrived here some other way
    // (an empty page set) needs re-reading.
    entry.parts = { unit: "page", parts: extraction.pageTexts ?? [] };
  } else {
    entry.parts = { unit: "section", parts: segmentText(extraction.text) };
  }
  return entry.parts;
}

async function load(fsPath: string): Promise<CacheEntry> {
  let key: string;
  try {
    const stats = await stat(fsPath);
    key = `${fsPath}:${stats.mtimeMs}:${stats.size}`;
  } catch (error) {
    return { key: "", extraction: { ok: false, kind: "unknown", reason: "corrupt", detail: errorMessage(error) } };
  }

  const hit = cache.get(fsPath);
  if (hit?.key === key) {
    // Refresh recency so the eviction below drops the least recently used file.
    cache.delete(fsPath);
    cache.set(fsPath, hit);
    return hit;
  }

  let extraction: DocumentExtraction;
  try {
    const buffer = new Uint8Array(await readFile(fsPath));
    extraction = await extractDocument(buffer, fsPath);
  } catch (error) {
    extraction = { ok: false, kind: "unknown", reason: "corrupt", detail: errorMessage(error) };
  }

  if (hit) {
    cachedChars -= entrySize(hit);
    cache.delete(fsPath);
  }
  const entry: CacheEntry = { key, extraction };
  cache.set(fsPath, entry);
  cachedChars += entrySize(entry);
  evict();
  return entry;
}

function entrySize(entry: CacheEntry): number {
  if (!entry.extraction.ok) {
    return 0;
  }
  // Page texts are held alongside `text`, so both count against the budget.
  return (
    entry.extraction.text.length +
    (entry.extraction.pageTexts?.reduce((total, page) => total + page.length, 0) ?? 0)
  );
}

function evict(): void {
  for (const [path, entry] of cache) {
    if (cachedChars <= MAX_CACHED_CHARS || cache.size <= 1) {
      return;
    }
    cache.delete(path);
    cachedChars -= entrySize(entry);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
