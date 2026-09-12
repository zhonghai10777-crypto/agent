import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { DocumentFailureReason } from "./document-extract";
import { getDocumentParts, type DocumentCacheOptions, type DocumentParts } from "./document-cache";
import { authorizeDocumentRead, isPathWithinRoot } from "./document-access";
import { MAX_LIBRARY_CHARS } from "./document-limits";
import { describeFailure } from "./document-runtime";
import { readJsonWithBackup, writeFileAtomicQueued } from "./atomic-file-write";

const INDEX_VERSION = 2;
const MAX_LIBRARY_FILES = 2_048;
const SUPPORTED_EXTENSIONS = new Set([".pdf", ".docx", ".xlsx", ".txt", ".md", ".csv"]);
const TRANSIENT_FAILURES = new Set<DocumentFailureReason>(["unavailable", "changed", "cancelled", "timeout", "worker-unavailable", "queue-full"]);

export interface LibraryDocument {
  readonly path: string;
  readonly title: string;
  readonly key: string;
  readonly unit: "page" | "section";
  readonly parts: readonly string[];
  readonly root?: string;
  readonly complete?: boolean;
  readonly charLimit?: number;
  readonly indexedAt?: string;
  readonly offline?: boolean;
}
export type LibrarySkipReason = DocumentFailureReason | "capacity";
export interface LibrarySkippedFile {
  readonly path: string;
  readonly reason: string;
  readonly reasonCode: LibrarySkipReason;
}
export interface LibraryRootStatus {
  readonly path: string;
  readonly state: "online" | "partial" | "offline";
  readonly checkedAt: string;
}
export interface LibraryIndexStatus {
  readonly state: "idle" | "indexing" | "ready";
  readonly total: number;
  readonly done: number;
  readonly documents: number;
  readonly parts: number;
  readonly skipped: readonly LibrarySkippedFile[];
  readonly snapshotAvailable?: boolean;
  readonly roots?: readonly LibraryRootStatus[];
}
interface PersistedLibraryFailure extends LibrarySkippedFile {
  readonly key: string;
  readonly failedAt?: number;
  readonly retryAfter?: number;
  readonly attempts?: number;
}
interface PersistedLibraryIndex {
  readonly version: number;
  readonly documents: readonly LibraryDocument[];
  readonly failures?: readonly PersistedLibraryFailure[];
}
interface LibraryCandidate { readonly path: string; readonly key: string; readonly root: string; }
export interface LibraryRebuildOptions { readonly retryFailures?: boolean; }
export interface LibraryIndexReader {
  rebuild(roots: readonly string[], onProgress?: (status: LibraryIndexStatus) => void, options?: LibraryRebuildOptions): Promise<void>;
  clear(options?: { readonly deleteDisk?: boolean }): Promise<void>;
  status(): LibraryIndexStatus;
  documents(): readonly LibraryDocument[];
}
export interface LibraryIndexDependencies {
  readonly maxIndexedChars?: number;
  readonly now?: () => number;
  readonly writeIndex?: typeof writeFileAtomicQueued;
  readonly getParts?: (filePath: string, options?: DocumentCacheOptions) => Promise<
    DocumentParts | { readonly ok: false; readonly reason: DocumentFailureReason; readonly detail?: string }
  >;
}

export class LibraryIndex implements LibraryIndexReader {
  private readonly indexPath: string;
  private readonly getParts: NonNullable<LibraryIndexDependencies["getParts"]>;
  private readonly writeIndex: typeof writeFileAtomicQueued;
  private readonly now: () => number;
  private readonly maxIndexedChars: number;
  private indexedDocuments: readonly LibraryDocument[] = [];
  private indexedFailures: readonly PersistedLibraryFailure[] = [];
  private currentStatus: LibraryIndexStatus = emptyStatus("idle");
  private loaded = false;
  private hasSnapshot = false;
  private generation = 0;
  private roots: readonly string[] = [];
  private active?: { signature: string; controller: AbortController; promise: Promise<void> };
  private saveTail: Promise<unknown> = Promise.resolve();

  constructor(indexDir: string, dependencies: LibraryIndexDependencies = {}) {
    this.indexPath = path.join(indexDir, "index.json");
    this.getParts = dependencies.getParts ?? getDocumentParts;
    this.writeIndex = dependencies.writeIndex ?? writeFileAtomicQueued;
    this.now = dependencies.now ?? Date.now;
    this.maxIndexedChars = Math.max(1, Math.trunc(dependencies.maxIndexedChars ?? MAX_LIBRARY_CHARS));
  }

  async rebuild(roots: readonly string[], onProgress?: (status: LibraryIndexStatus) => void, options: LibraryRebuildOptions = {}): Promise<void> {
    const normalized = normalizeRoots(roots);
    const signature = normalized.join("\0");
    if (this.active?.signature === signature && !options.retryFailures) return this.active.promise;
    this.active?.controller.abort();
    const generation = ++this.generation;
    if (!normalized.some((root) => this.roots.includes(root))) this.hasSnapshot = false;
    this.roots = normalized;
    // Revocation takes effect synchronously, before scanning or waiting on I/O.
    this.indexedDocuments = this.indexedDocuments.filter((doc) => libraryDocumentIsAuthorized(doc, normalized));
    this.indexedFailures = this.indexedFailures.filter((file) => normalized.some((root) => isPathWithinRoot(file.path, root)));
    const controller = new AbortController();
    const task = this.performRebuild(normalized, generation, controller.signal, onProgress, options);
    this.active = { signature, controller, promise: task };
    try { await task; }
    catch (error) {
      if (generation === this.generation) this.publish({
        ...this.currentStatus, state: this.hasSnapshot ? "ready" : "idle",
        skipped: [...this.currentStatus.skipped, unavailable(this.indexPath, error)],
      }, onProgress);
      throw error;
    } finally { if (this.active?.promise === task) this.active = undefined; }
  }

  async clear(options: { readonly deleteDisk?: boolean } = {}): Promise<void> {
    const generation = ++this.generation;
    this.active?.controller.abort();
    this.active = undefined;
    this.indexedDocuments = []; this.indexedFailures = []; this.roots = [];
    this.currentStatus = emptyStatus("idle"); this.hasSnapshot = false; this.loaded = true;
    // An empty committed snapshot is a tombstone: a previous .bak can no longer
    // resurrect cleared content. Existing source files and backups are retained.
    if (options.deleteDisk) await this.save({ version: INDEX_VERSION, documents: [], failures: [] }, generation);
  }

  status(): LibraryIndexStatus {
    const documents = this.documents();
    return { ...this.currentStatus, documents: documents.length,
      parts: documents.reduce((sum, doc) => sum + doc.parts.length, 0),
      snapshotAvailable: this.hasSnapshot,
      roots: this.currentStatus.roots?.filter((root) => this.roots.includes(root.path)),
      skipped: this.currentStatus.skipped.filter((entry) => entry.path === this.indexPath ||
        this.roots.some((root) => entry.path === root || isPathWithinRoot(entry.path, root))),
    };
  }
  documents(): readonly LibraryDocument[] { return this.indexedDocuments.filter((doc) => libraryDocumentIsAuthorized(doc, this.roots)); }

  private async performRebuild(roots: readonly string[], generation: number, signal: AbortSignal,
    onProgress: ((status: LibraryIndexStatus) => void) | undefined, options: LibraryRebuildOptions): Promise<void> {
    await this.loadPersistedIndex(generation);
    if (generation !== this.generation) return;
    this.publish({ ...emptyStatus("indexing"), snapshotAvailable: this.hasSnapshot }, onProgress);
    const scan = await scanLibraryRoots(roots, signal, this.now);
    if (generation !== this.generation) return;
    const previousByPath = new Map(this.indexedDocuments.map((doc) => [doc.path, doc]));
    const previousFailureByPath = new Map(this.indexedFailures.map((file) => [file.path, file]));
    const candidatePaths = new Set(scan.candidates.map((file) => file.path));
    // An unreliable root cannot prove deletion. Keep its authorized old snapshot
    // with its original timestamp and an explicit offline/partial marker.
    const retained = this.indexedDocuments.filter((doc) => !candidatePaths.has(doc.path) &&
      scan.roots.some((root) => root.state !== "online" && libraryDocumentIsAuthorized(doc, [root.path])));
    const nextDocuments: LibraryDocument[] = retained.map((doc) => ({ ...doc, offline: true }));
    const nextFailures: PersistedLibraryFailure[] = [];
    const skipped: LibrarySkippedFile[] = [...scan.skipped];
    let indexedChars = nextDocuments.reduce((sum, doc) => sum + doc.parts.reduce((count, part) => count + part.length, 0), 0);
    this.publish({ ...emptyStatus("indexing"), total: scan.candidates.length, skipped, roots: scan.roots }, onProgress);

    for (const [index, candidate] of scan.candidates.entries()) {
      if (generation !== this.generation) return;
      const previous = previousByPath.get(candidate.path);
      const priorFailure = previousFailureByPath.get(candidate.path);
      let document: LibraryDocument | undefined;
      if (previous?.key === candidate.key && previous.complete !== undefined) {
        document = { ...previous, root: candidate.root, offline: false };
      } else if (priorFailure?.key === candidate.key && priorFailure.reasonCode !== "capacity" &&
          !options.retryFailures && (priorFailure.retryAfter ?? 0) > this.now()) {
        nextFailures.push(priorFailure); skipped.push(priorFailure);
      } else {
        let extracted: Awaited<ReturnType<NonNullable<LibraryIndexDependencies["getParts"]>>>;
        try { extracted = await this.getParts(candidate.path, { signal, retryFailures: options.retryFailures, expectedVersion: candidate.key }); }
        catch (error) { extracted = { ok: false, reason: "unavailable", detail: String(error) }; }
        if (generation !== this.generation) return;
        if ("ok" in extracted) {
          const attempts = (priorFailure?.attempts ?? 0) + 1;
          const delay = TRANSIENT_FAILURES.has(extracted.reason) ? Math.min(60_000, 1_000 * 2 ** Math.min(attempts - 1, 6)) : 24 * 60 * 60_000;
          const failure: PersistedLibraryFailure = { path: candidate.path, key: candidate.key,
            reason: describeFailure(extracted.reason, extracted.detail), reasonCode: extracted.reason,
            failedAt: this.now(), retryAfter: this.now() + delay, attempts };
          nextFailures.push(failure); skipped.push(failure);
        } else {
          document = { path: candidate.path, title: path.basename(candidate.path, path.extname(candidate.path)),
            key: extracted.sourceVersion ?? candidate.key, unit: extracted.unit, parts: extracted.parts,
            root: candidate.root, complete: extracted.complete !== false, charLimit: extracted.charLimit,
            indexedAt: new Date(this.now()).toISOString(), offline: false };
        }
      }
      if (document) {
        const chars = document.parts.reduce((sum, part) => sum + part.length, 0);
        if (indexedChars + chars > this.maxIndexedChars) {
          const failure: PersistedLibraryFailure = { path: candidate.path, key: candidate.key, reasonCode: "capacity",
            reason: "The local library reached its character limit. Free capacity and rebuild to retry this document." };
          nextFailures.push(failure); skipped.push(failure);
        } else { nextDocuments.push(document); indexedChars += chars; }
      }
      this.publish({ ...this.currentStatus, state: "indexing", done: index + 1, skipped }, onProgress);
    }
    if (generation !== this.generation) return;
    nextDocuments.sort((a, b) => a.path.localeCompare(b.path));
    const committed = await this.save({ version: INDEX_VERSION, documents: nextDocuments, failures: nextFailures }, generation);
    // This check is after async atomic writes too: a late old save must never
    // restore memory after Clear, root revocation, or a newer rebuild.
    if (!committed) return;
    this.indexedDocuments = nextDocuments; this.indexedFailures = nextFailures;
    this.hasSnapshot = this.hasSnapshot || nextDocuments.length > 0 || scan.roots.every((root) => root.state === "online");
    this.publish({ ...this.currentStatus, state: "ready", done: scan.candidates.length, skipped, roots: scan.roots }, onProgress);
  }

  private async save(snapshot: PersistedLibraryIndex, generation: number): Promise<boolean> {
    const task = this.saveTail.catch(() => undefined).then(async () => {
      if (generation !== this.generation) return false;
      await this.writeIndex(this.indexPath, `${JSON.stringify(snapshot)}\n`);
      return generation === this.generation;
    });
    this.saveTail = task;
    return task;
  }

  private async loadPersistedIndex(generation: number): Promise<void> {
    if (this.loaded) return;
    // Older 100M-character caches may exceed the current low-memory budget.
    // Rebuild those without reading a huge JSON string into the main process.
    const maxBytes = this.maxIndexedChars * 6 + 1_000_000;
    for (const file of [this.indexPath, `${this.indexPath}.bak`]) {
      try { if ((await stat(file)).size > maxBytes) { this.loaded = true; return; } } catch { /* absent cache */ }
    }
    const saved = await readJsonWithBackup<unknown>(this.indexPath);
    if (generation !== this.generation) return;
    this.loaded = true;
    const parsed = parsePersistedIndex(saved.value);
    let chars = 0;
    this.indexedDocuments = parsed.documents.filter((doc) => {
      if (!libraryDocumentIsAuthorized(doc, this.roots)) return false;
      chars += doc.parts.reduce((sum, part) => sum + part.length, 0);
      return chars <= this.maxIndexedChars;
    });
    this.indexedFailures = parsed.failures;
    this.hasSnapshot = parsed.valid && this.indexedDocuments.length > 0;
  }
  private publish(status: LibraryIndexStatus, callback?: (status: LibraryIndexStatus) => void): void {
    this.currentStatus = status;
    try { callback?.(this.status()); } catch (error) { console.warn("[library-index] progress callback failed:", error); }
  }
}

export function libraryDocumentIsAuthorized(document: Pick<LibraryDocument, "path" | "root">, roots: readonly string[]): boolean {
  return roots.some((root) => document.root ? document.root === path.normalize(root) || isPathWithinRoot(document.root, root) : isPathWithinRoot(document.path, root));
}
function emptyStatus(state: LibraryIndexStatus["state"]): LibraryIndexStatus { return { state, total: 0, done: 0, documents: 0, parts: 0, skipped: [] }; }
function normalizeRoots(roots: readonly string[]): readonly string[] { return [...new Set(roots.filter((root) => path.isAbsolute(root)).map((root) => path.normalize(root)))].sort(); }

async function scanLibraryRoots(roots: readonly string[], signal: AbortSignal, now: () => number): Promise<{
  candidates: LibraryCandidate[]; skipped: LibrarySkippedFile[]; roots: LibraryRootStatus[];
}> {
  const candidates = new Map<string, LibraryCandidate>();
  const skipped: LibrarySkippedFile[] = [];
  const statuses: LibraryRootStatus[] = [];
  let visited = 0;
  for (const root of roots) {
    let state: LibraryRootStatus["state"] = "online";
    const walk = async (directory: string, depth: number): Promise<void> => {
      if (signal.aborted) return;
      if (depth > 32 || visited > 10_000 || candidates.size >= MAX_LIBRARY_FILES) {
        state = "partial"; skipped.push({ path: directory, reasonCode: "capacity", reason: "Library scan limit reached. Use fewer files or a smaller folder." }); return;
      }
      let entries;
      try { entries = await boundedScanIo(readdir(directory, { withFileTypes: true }), signal); }
      catch (error) { state = directory === root ? "offline" : "partial"; skipped.push(unavailable(directory, error)); return; }
      for (const entry of entries) {
        if (signal.aborted) return;
        if (++visited > 10_000 || candidates.size >= MAX_LIBRARY_FILES) { state = "partial"; skipped.push({ path: directory, reasonCode: "capacity", reason: "Library file count limit reached." }); return; }
        if (entry.name.startsWith(".") || entry.name.startsWith("~$") || entry.isSymbolicLink()) continue;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) { await walk(file, depth + 1); continue; }
        if (!entry.isFile() || !SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
        try {
          const authorized = await boundedScanIo(authorizeDocumentRead(file, { workspaceRoots: [root], allowedFiles: [] }), signal);
          candidates.set(authorized.path, { path: authorized.path, key: authorized.sourceVersion, root });
        } catch (error) { state = "partial"; skipped.push(unavailable(file, error)); }
      }
    };
    await walk(root, 0);
    statuses.push({ path: root, state, checkedAt: new Date(now()).toISOString() });
  }
  return { candidates: [...candidates.values()].sort((a, b) => a.path.localeCompare(b.path)), skipped, roots: statuses };
}
function unavailable(file: string, error: unknown): LibrarySkippedFile { return { path: file, reason: `This library path is temporarily unavailable (${error instanceof Error ? error.message : String(error)}).`, reasonCode: "unavailable" }; }
function boundedScanIo<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error, result?: T) => {
      clearTimeout(timer); signal.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(result as T);
    };
    const abort = () => finish(new Error("Library scan cancelled."));
    const timer = setTimeout(() => finish(new Error("Library filesystem operation timed out.")), 5_000);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    operation.then((result) => finish(undefined, result), (error) => finish(error));
  });
}
function parsePersistedIndex(value: unknown): { documents: LibraryDocument[]; failures: PersistedLibraryFailure[]; valid: boolean } {
  if (typeof value !== "object" || !value) return { documents: [], failures: [], valid: false };
  const input = value as Partial<PersistedLibraryIndex>;
  if (![1, INDEX_VERSION].includes(input.version ?? 0) || !Array.isArray(input.documents)) return { documents: [], failures: [], valid: false };
  return { valid: true, documents: input.documents.filter(isLibraryDocument).slice(0, MAX_LIBRARY_FILES),
    failures: Array.isArray(input.failures) ? input.failures.filter((file) => typeof file === "object" && file !== null &&
      typeof file.path === "string" && typeof file.key === "string" && typeof file.reason === "string" && typeof file.reasonCode === "string").slice(0, MAX_LIBRARY_FILES) : [] };
}
function isLibraryDocument(value: unknown): value is LibraryDocument {
  if (typeof value !== "object" || !value) return false;
  const doc = value as Partial<LibraryDocument>;
  return typeof doc.path === "string" && path.isAbsolute(doc.path) && typeof doc.title === "string" && typeof doc.key === "string" &&
    (doc.unit === "page" || doc.unit === "section") && Array.isArray(doc.parts) && doc.parts.every((part) => typeof part === "string") &&
    (doc.root === undefined || typeof doc.root === "string" && path.isAbsolute(doc.root)) &&
    (doc.complete === undefined || typeof doc.complete === "boolean");
}
