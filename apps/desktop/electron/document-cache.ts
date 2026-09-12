import { readFile, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import type { DocumentExtraction, DocumentExtractionFailure, DocumentKind } from "./document-extract";
import { segmentText } from "./document-extract";
import { MAX_DOCUMENT_BYTES } from "./document-limits";
import { documentVersion } from "./document-file";
import { DocumentWorkerClient } from "./document-worker-client";

export interface DocumentParts {
  readonly unit: "page" | "section";
  readonly parts: readonly string[];
  readonly kind?: DocumentKind;
  readonly sourceVersion?: string;
  readonly complete?: boolean;
  readonly charLimit?: number;
}
interface CacheEntry {
  readonly key: string;
  readonly extraction: DocumentExtraction;
  readonly expiresAt?: number;
}
export interface DocumentCacheIo {
  readonly stat: (fsPath: string) => Promise<Stats>;
  readonly readFile: (fsPath: string) => Promise<Uint8Array>;
}
export interface DocumentCacheOptions {
  readonly io?: DocumentCacheIo;
  readonly now?: () => number;
  readonly retryFailures?: boolean;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly expectedVersion?: string;
  readonly worker?: DocumentWorkerClient;
}

export const FAILURE_TTL_MS = 60_000;
const MAX_CACHED_CHARS = 4_500_000;
const MAX_CACHE_ENTRIES = 128;
const cache = new Map<string, CacheEntry>();
const worker = new DocumentWorkerClient();
let cachedChars = 0;
let generation = 0;
const nodeIo: DocumentCacheIo = { stat, readFile: async (file) => new Uint8Array(await readFile(file)) };

export async function getDocumentExtraction(file: string, options: DocumentCacheOptions = {}): Promise<DocumentExtraction> {
  return (await load(file, options)).extraction;
}

export async function getDocumentParts(file: string, options: DocumentCacheOptions = {}): Promise<DocumentParts | DocumentExtractionFailure> {
  const entry = await load(file, options);
  const result = entry.extraction;
  if (!result.ok) return result;
  return {
    unit: result.kind === "pdf" ? "page" : "section",
    parts: result.kind === "pdf" ? result.pageTexts ?? [] : result.sectionTexts ?? segmentText(result.text),
    kind: result.kind, sourceVersion: entry.key,
    complete: result.meta.complete !== false, charLimit: result.meta.charLimit,
  };
}

/** Only derived memory entries are invalidated. Source documents are untouched. */
export function invalidateDocumentCache(file?: string): void {
  generation += 1;
  if (file === undefined) { cache.clear(); cachedChars = 0; return; }
  const hit = cache.get(file);
  if (hit) { cachedChars -= entrySize(hit); cache.delete(file); }
}

async function load(file: string, options: DocumentCacheOptions): Promise<CacheEntry> {
  const io = options.io ?? nodeIo;
  const now = options.now ?? Date.now;
  if (options.signal?.aborted) return failed("cancelled", "DOCUMENT_CANCELLED", "Document reading was cancelled.");
  let info: Stats;
  try { info = await io.stat(file); }
  catch (error) { return failed("unavailable", "DOCUMENT_UNREADABLE", error instanceof Error ? error.message : String(error)); }
  const key = documentVersion(file, info);
  if (options.expectedVersion && options.expectedVersion !== key) {
    return failed("changed", "DOCUMENT_CHANGED", "The document has changed. Search again or read from the current version.");
  }
  const hit = cache.get(file);
  if (hit?.key === key && (hit.expiresAt === undefined || now() < hit.expiresAt) && !(options.retryFailures && !hit.extraction.ok)) {
    cache.delete(file); cache.set(file, hit);
    return hit;
  }
  if (!info.isFile()) return failed("unavailable", "DOCUMENT_UNREADABLE", "Not a regular file.");
  if (info.size > MAX_DOCUMENT_BYTES) return failed("too-large", "DOCUMENT_TOO_LARGE", `Input exceeds ${MAX_DOCUMENT_BYTES} bytes.`);
  const startedGeneration = generation;
  const extraction = await (options.worker ?? worker).run(file, key, {
    signal: options.signal, timeoutMs: options.timeoutMs,
    ...(options.io ? { readBuffer: () => io.readFile(file) } : {}),
  });
  const entry: CacheEntry = { key, extraction, ...(extraction.ok ? {} : { expiresAt: now() + FAILURE_TTL_MS }) };
  if (options.signal?.aborted) return failed("cancelled", "DOCUMENT_CANCELLED", "Document reading was cancelled.");
  // Operational failures must remain retryable. Shared requests coalesce in the
  // Worker client, so cancelling one reader never cancels another subscriber.
  if (!extraction.ok && ["unavailable", "cancelled", "timeout", "worker-unavailable", "queue-full", "changed"].includes(extraction.reason)) return entry;
  try {
    if (documentVersion(file, await io.stat(file)) !== key) return failed("changed", "DOCUMENT_CHANGED", "Document changed during extraction.");
  } catch { return failed("unavailable", "DOCUMENT_UNREADABLE", "Document became unavailable during extraction."); }
  if (generation !== startedGeneration) return entry;
  const old = cache.get(file);
  if (old) cachedChars -= entrySize(old);
  cache.set(file, entry); cachedChars += entrySize(entry);
  for (const [filePath, cached] of cache) {
    if (cachedChars <= MAX_CACHED_CHARS && cache.size <= MAX_CACHE_ENTRIES) break;
    cache.delete(filePath); cachedChars -= entrySize(cached);
  }
  return entry;
}

function failed(reason: DocumentExtractionFailure["reason"], code: string, detail: string): CacheEntry {
  return { key: "", extraction: { ok: false, kind: "unknown", reason, code, detail } };
}
function entrySize(entry: CacheEntry): number {
  const result = entry.extraction;
  return result.ok ? result.text.length + (result.pageTexts ?? result.sectionTexts ?? []).reduce((sum, part) => sum + part.length, 0) : 0;
}
