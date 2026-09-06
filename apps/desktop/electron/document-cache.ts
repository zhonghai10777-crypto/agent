import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Stats } from "node:fs";
import { Worker } from "node:worker_threads";
import {
  extractDocument,
  MAX_DOCUMENT_BYTES,
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
 *
 * I/O errors are not cached. Parse failures expire after a minute and an
 * explicit reattachment retries immediately, even if file metadata is unchanged.
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
  /** Set for cached parse failures only; successes never expire on time. */
  readonly expiresAt?: number;
}

/** Bounded by total extracted characters rather than entry count. */
const MAX_CACHED_CHARS = 4_000_000;
const MAX_CACHE_ENTRIES = 128;

/** How long a parse failure stays cached. */
export const FAILURE_TTL_MS = 60_000;

const cache = new Map<string, CacheEntry>();
let cachedChars = 0;

/**
 * File access, injectable so tests can exercise the transient-failure path
 * (which is otherwise unreachable without a real lock on a real file).
 */
export interface DocumentCacheIo {
  readonly stat: (fsPath: string) => Promise<Stats>;
  readonly readFile: (fsPath: string) => Promise<Uint8Array>;
}

interface DocumentCacheOptions {
  readonly io?: DocumentCacheIo;
  readonly now?: () => number;
  readonly retryFailures?: boolean;
}

const nodeIo: DocumentCacheIo = { stat, readFile: async (fsPath) => new Uint8Array(await readFile(fsPath)) };

interface PendingWorkerRequest {
  readonly resolve: (value: DocumentExtraction) => void;
  readonly reject: (reason?: unknown) => void;
}

let extractionWorker: Worker | undefined;
let workerRequestId = 0;
const pendingWorkerRequests = new Map<number, PendingWorkerRequest>();

export async function getDocumentExtraction(fsPath: string, options: DocumentCacheOptions = {}): Promise<DocumentExtraction> {
  return (await load(fsPath, options)).extraction;
}

/**
 * The document as addressable parts, for read_document. PDFs page natively;
 * everything else is chunked on paragraph boundaries so the tool has the same
 * "fetch part N" shape for every format.
 */
export async function getDocumentParts(
  fsPath: string,
  options: DocumentCacheOptions = {},
): Promise<DocumentParts | DocumentExtractionFailure> {
  const entry = await load(fsPath, options);
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

/**
 * Forget what is cached for `fsPath` (or everything). Use it when the user
 * retries a document that failed: a parse failure otherwise stands until its TTL
 * runs out, and a retry the user asked for should actually re-read the file.
 */
export function invalidateDocumentCache(fsPath?: string): void {
  if (fsPath === undefined) {
    cache.clear();
    cachedChars = 0;
    return;
  }
  const entry = cache.get(fsPath);
  if (entry) {
    cachedChars -= entrySize(entry);
    cache.delete(fsPath);
  }
}

async function load(fsPath: string, options: DocumentCacheOptions): Promise<CacheEntry> {
  const io = options.io ?? nodeIo;
  const now = options.now ?? Date.now;
  let key: string;
  let stats: Stats;
  try {
    stats = await io.stat(fsPath);
    key = `${fsPath}:${stats.mtimeMs}:${stats.size}`;
  } catch (error) {
    // Not cached: the file may well be readable a moment later.
    return { key: "", extraction: { ok: false, kind: "unknown", reason: "corrupt", detail: errorMessage(error) } };
  }

  const hit = cache.get(fsPath);
  if (hit?.key === key && (hit.expiresAt === undefined || now() < hit.expiresAt) &&
      !(options.retryFailures && !hit.extraction.ok)) {
    // Refresh recency so the eviction below drops the least recently used file.
    cache.delete(fsPath);
    cache.set(fsPath, hit);
    return hit;
  }

  let extraction: DocumentExtraction;
  try {
    if (stats.size > MAX_DOCUMENT_BYTES) {
      extraction = {
        ok: false,
        kind: "unknown",
        reason: "too-large",
        detail: `${stats.size} bytes exceeds ${MAX_DOCUMENT_BYTES}`,
      };
    } else {
      const buffer = await io.readFile(fsPath);
      extraction = await extractDocumentInWorker(buffer, fsPath);
    }
  } catch (error) {
    // The read itself failed, so this says nothing about the document. Drop any
    // stale entry and return uncached, leaving the next attempt free to succeed.
    invalidateDocumentCache(fsPath);
    return { key: "", extraction: { ok: false, kind: "unknown", reason: "corrupt", detail: errorMessage(error) } };
  }

  invalidateDocumentCache(fsPath);
  const entry: CacheEntry = {
    key,
    extraction,
    ...(extraction.ok ? {} : { expiresAt: now() + FAILURE_TTL_MS }),
  };
  cache.set(fsPath, entry);
  cachedChars += entrySize(entry);
  evict();
  return entry;
}

async function extractDocumentInWorker(buffer: Uint8Array, fileName: string): Promise<DocumentExtraction> {
  const workerPath = await resolveDocumentWorkerPath();
  if (!workerPath) {
    return extractDocument(buffer, fileName);
  }

  const worker = getExtractionWorker(workerPath);
  const id = ++workerRequestId;
  const promise = new Promise<DocumentExtraction>((resolve, reject) => {
    pendingWorkerRequests.set(id, { resolve, reject });
  });
  const transferable = buffer.slice().buffer;
  worker.postMessage({ id, buffer: transferable, fileName }, [transferable]);
  return promise.catch(() => extractDocument(buffer, fileName));
}

function getExtractionWorker(workerPath: string): Worker {
  if (extractionWorker) {
    return extractionWorker;
  }
  const worker = new Worker(workerPath);
  extractionWorker = worker;
  worker.on("message", (message: { readonly id: number; readonly result?: DocumentExtraction; readonly error?: string }) => {
    const pending = pendingWorkerRequests.get(message.id);
    if (!pending) return;
    pendingWorkerRequests.delete(message.id);
    if (message.result) pending.resolve(message.result);
    else pending.reject(new Error(message.error ?? "Document worker failed."));
  });
  worker.on("error", (error) => {
    extractionWorker = undefined;
    for (const pending of pendingWorkerRequests.values()) pending.reject(error);
    pendingWorkerRequests.clear();
  });
  worker.on("exit", (code) => {
    if (code !== 0 && extractionWorker === worker) {
      extractionWorker = undefined;
      const error = new Error(`Document worker exited with code ${code}.`);
      for (const pending of pendingWorkerRequests.values()) pending.reject(error);
      pendingWorkerRequests.clear();
    }
  });
  return worker;
}

async function resolveDocumentWorkerPath(): Promise<string | undefined> {
  const candidates = [
    path.join(process.cwd(), "out", "main", "document-worker.mjs"),
    path.join(process.cwd(), "apps", "desktop", "out", "main", "document-worker.mjs"),
    process.resourcesPath
      ? path.join(process.resourcesPath, "app.asar", "out", "main", "document-worker.mjs")
      : undefined,
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next development or packaged-app location.
    }
  }
  return undefined;
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
    if ((cachedChars <= MAX_CACHED_CHARS && cache.size <= MAX_CACHE_ENTRIES) || cache.size <= 1) {
      return;
    }
    cache.delete(path);
    cachedChars -= entrySize(entry);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
