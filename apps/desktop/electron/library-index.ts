import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { DocumentFailureReason } from "./document-extract";
import { getDocumentParts, type DocumentParts } from "./document-cache";
import { describeFailure } from "./document-runtime";
import { readJsonWithBackup, writeFileAtomicQueued } from "./atomic-file-write";

const INDEX_VERSION = 1;
const MAX_INDEXED_CHARS = 100_000_000;
const SUPPORTED_EXTENSIONS = new Set([".pdf", ".docx", ".xlsx", ".txt", ".md", ".csv"]);

export interface LibraryDocument {
  readonly path: string;
  readonly title: string;
  readonly key: string;
  readonly unit: "page" | "section";
  readonly parts: readonly string[];
}

export type LibrarySkipReason = DocumentFailureReason | "unavailable" | "capacity";

export interface LibrarySkippedFile {
  readonly path: string;
  readonly reason: string;
  readonly reasonCode: LibrarySkipReason;
}

export interface LibraryIndexStatus {
  readonly state: "idle" | "indexing" | "ready";
  readonly total: number;
  readonly done: number;
  readonly documents: number;
  readonly parts: number;
  readonly skipped: readonly LibrarySkippedFile[];
}

interface PersistedLibraryIndex {
  readonly version: number;
  readonly documents: readonly LibraryDocument[];
  readonly failures?: readonly PersistedLibraryFailure[];
}

interface PersistedLibraryFailure extends LibrarySkippedFile {
  readonly key: string;
}

interface LibraryCandidate {
  readonly path: string;
  readonly key: string;
}

export interface LibraryIndexReader {
  rebuild(roots: readonly string[], onProgress?: (status: LibraryIndexStatus) => void): Promise<void>;
  status(): LibraryIndexStatus;
  documents(): readonly LibraryDocument[];
}

export interface LibraryIndexDependencies {
  readonly getParts?: (
    filePath: string,
  ) => Promise<
    DocumentParts | { readonly ok: false; readonly reason: DocumentFailureReason; readonly detail?: string }
  >;
}

export class LibraryIndex implements LibraryIndexReader {
  private readonly indexPath: string;
  private readonly getParts: NonNullable<LibraryIndexDependencies["getParts"]>;
  private indexedDocuments: readonly LibraryDocument[] = [];
  private indexedFailures: readonly PersistedLibraryFailure[] = [];
  private currentStatus: LibraryIndexStatus = emptyStatus("idle");
  private loaded = false;
  private rebuildPromise: Promise<void> | undefined;
  private activeRootsSignature = "";

  constructor(indexDir: string, dependencies: LibraryIndexDependencies = {}) {
    this.indexPath = path.join(indexDir, "index.json");
    this.getParts = dependencies.getParts ?? getDocumentParts;
  }

  async rebuild(roots: readonly string[], onProgress?: (status: LibraryIndexStatus) => void): Promise<void> {
    const normalizedRoots = normalizeRoots(roots);
    const signature = normalizedRoots.join("\0");

    if (this.rebuildPromise) {
      if (signature === this.activeRootsSignature) {
        return this.rebuildPromise;
      }
      try {
        await this.rebuildPromise;
      } catch {
        // A newer rebuild should still get a chance to recover from an earlier failure.
      }
    }

    this.activeRootsSignature = signature;
    const task = this.performRebuild(normalizedRoots, onProgress);
    this.rebuildPromise = task;
    try {
      await task;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.currentStatus = {
        ...this.currentStatus,
        state: "ready",
        skipped: [
          ...this.currentStatus.skipped,
          {
            path: this.indexPath,
            reason: `The local library index could not be saved (${message}).`,
            reasonCode: "unavailable",
          },
        ],
      };
      throw error;
    } finally {
      if (this.rebuildPromise === task) {
        this.rebuildPromise = undefined;
        this.activeRootsSignature = "";
      }
    }
  }

  status(): LibraryIndexStatus {
    return {
      ...this.currentStatus,
      skipped: [...this.currentStatus.skipped],
    };
  }

  documents(): readonly LibraryDocument[] {
    return this.indexedDocuments;
  }

  private async performRebuild(
    roots: readonly string[],
    onProgress?: (status: LibraryIndexStatus) => void,
  ): Promise<void> {
    await this.loadPersistedIndex();
    this.publish({ ...emptyStatus("indexing") }, onProgress);

    const scan = await scanLibraryRoots(roots);
    const previousByPath = new Map(this.indexedDocuments.map((document) => [document.path, document]));
    const previousFailureByPath = new Map(this.indexedFailures.map((failure) => [failure.path, failure]));
    const nextDocuments: LibraryDocument[] = [];
    const nextFailures: PersistedLibraryFailure[] = [];
    const skipped: LibrarySkippedFile[] = [...scan.skipped];
    let indexedChars = 0;
    let parts = 0;

    this.publish(
      {
        state: "indexing",
        total: scan.candidates.length,
        done: 0,
        documents: 0,
        parts: 0,
        skipped,
      },
      onProgress,
    );

    for (const [index, candidate] of scan.candidates.entries()) {
      const previous = previousByPath.get(candidate.path);
      let document: LibraryDocument | undefined;

      if (previous?.key === candidate.key) {
        document = previous;
      } else {
        const previousFailure = previousFailureByPath.get(candidate.path);
        if (previousFailure?.key === candidate.key) {
          nextFailures.push(previousFailure);
          skipped.push(withoutKey(previousFailure));
        } else {
          const extracted = await this.getParts(candidate.path);
          if ("ok" in extracted) {
            const failure: PersistedLibraryFailure = {
              path: candidate.path,
              key: candidate.key,
              reason: describeFailure(extracted.reason, extracted.detail),
              reasonCode: extracted.reason,
            };
            nextFailures.push(failure);
            skipped.push(withoutKey(failure));
          } else {
            document = {
              path: candidate.path,
              title: path.basename(candidate.path, path.extname(candidate.path)),
              key: candidate.key,
              unit: extracted.unit,
              parts: extracted.parts,
            };
          }
        }
      }

      if (document) {
        const documentChars = document.parts.reduce((total, part) => total + part.length, 0);
        if (indexedChars + documentChars > MAX_INDEXED_CHARS) {
          console.warn(`[library-index] character budget reached; omitted ${candidate.path}`);
          const failure: PersistedLibraryFailure = {
            path: candidate.path,
            key: candidate.key,
            reason: "The local library index reached its size limit, so this document was omitted.",
            reasonCode: "capacity",
          };
          nextFailures.push(failure);
          skipped.push(withoutKey(failure));
        } else {
          nextDocuments.push(document);
          indexedChars += documentChars;
          parts += document.parts.length;
        }
      }

      this.publish(
        {
          state: "indexing",
          total: scan.candidates.length,
          done: index + 1,
          documents: nextDocuments.length,
          parts,
          skipped,
        },
        onProgress,
      );
    }

    nextDocuments.sort((left, right) => left.path.localeCompare(right.path));
    nextFailures.sort((left, right) => left.path.localeCompare(right.path));
    if (
      !sameVersionedEntries(this.indexedDocuments, nextDocuments) ||
      !sameVersionedEntries(this.indexedFailures, nextFailures)
    ) {
      await writeFileAtomicQueued(
        this.indexPath,
        `${JSON.stringify({ version: INDEX_VERSION, documents: nextDocuments, failures: nextFailures } satisfies PersistedLibraryIndex)}\n`,
      );
    }

    this.indexedDocuments = nextDocuments;
    this.indexedFailures = nextFailures;
    this.publish(
      {
        state: "ready",
        total: scan.candidates.length,
        done: scan.candidates.length,
        documents: nextDocuments.length,
        parts,
        skipped,
      },
      onProgress,
    );
  }

  private async loadPersistedIndex(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    const persisted = await readJsonWithBackup<unknown>(this.indexPath);
    if (persisted.corrupted) {
      console.warn("[library-index] persisted index was corrupt; rebuilding from source documents.");
    }
    const parsed = parsePersistedIndex(persisted.value);
    this.indexedDocuments = parsed.documents;
    this.indexedFailures = parsed.failures;
  }

  private publish(status: LibraryIndexStatus, onProgress?: (status: LibraryIndexStatus) => void): void {
    this.currentStatus = { ...status, skipped: [...status.skipped] };
    try {
      onProgress?.(this.status());
    } catch (error) {
      console.warn("[library-index] progress callback failed:", error);
    }
  }
}

function emptyStatus(state: LibraryIndexStatus["state"]): LibraryIndexStatus {
  return { state, total: 0, done: 0, documents: 0, parts: 0, skipped: [] };
}

function normalizeRoots(roots: readonly string[]): readonly string[] {
  return roots
    .filter((root) => path.isAbsolute(root))
    .map((root) => path.normalize(root))
    .filter((root, index, all) => all.indexOf(root) === index)
    .sort((left, right) => left.localeCompare(right));
}

async function scanLibraryRoots(
  roots: readonly string[],
): Promise<{ readonly candidates: readonly LibraryCandidate[]; readonly skipped: readonly LibrarySkippedFile[] }> {
  const candidates = new Map<string, LibraryCandidate>();
  const skipped: LibrarySkippedFile[] = [];

  for (const root of roots) {
    await scanDirectory(root, candidates, skipped);
  }

  return {
    candidates: [...candidates.values()].sort((left, right) => left.path.localeCompare(right.path)),
    skipped,
  };
}

async function scanDirectory(
  directory: string,
  candidates: Map<string, LibraryCandidate>,
  skipped: LibrarySkippedFile[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    skipped.push(unavailable(directory, error));
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name.startsWith("~$") || entry.isSymbolicLink()) {
      continue;
    }
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await scanDirectory(entryPath, candidates, skipped);
      continue;
    }
    if (!entry.isFile() || !SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      continue;
    }
    try {
      const fileStat = await stat(entryPath);
      const absolutePath = path.resolve(entryPath);
      candidates.set(absolutePath, {
        path: absolutePath,
        key: `${absolutePath}:${fileStat.mtimeMs}:${fileStat.size}`,
      });
    } catch (error) {
      skipped.push(unavailable(entryPath, error));
    }
  }
}

function unavailable(filePath: string, error: unknown): LibrarySkippedFile {
  const detail = error instanceof Error ? error.message : String(error);
  return {
    path: filePath,
    reason: `This library path could not be read (${detail}).`,
    reasonCode: "unavailable",
  };
}

function parsePersistedIndex(value: unknown): {
  readonly documents: readonly LibraryDocument[];
  readonly failures: readonly PersistedLibraryFailure[];
} {
  if (typeof value !== "object" || value === null) {
    return { documents: [], failures: [] };
  }
  const input = value as Partial<PersistedLibraryIndex>;
  if (input.version !== INDEX_VERSION || !Array.isArray(input.documents)) {
    return { documents: [], failures: [] };
  }
  return {
    documents: input.documents.filter(isLibraryDocument),
    failures: Array.isArray(input.failures) ? input.failures.filter(isPersistedLibraryFailure) : [],
  };
}

function isLibraryDocument(value: unknown): value is LibraryDocument {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const document = value as Partial<LibraryDocument>;
  return (
    typeof document.path === "string" &&
    path.isAbsolute(document.path) &&
    typeof document.title === "string" &&
    typeof document.key === "string" &&
    (document.unit === "page" || document.unit === "section") &&
    Array.isArray(document.parts) &&
    document.parts.every((part) => typeof part === "string")
  );
}

function isPersistedLibraryFailure(value: unknown): value is PersistedLibraryFailure {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const failure = value as Partial<PersistedLibraryFailure>;
  return (
    typeof failure.path === "string" &&
    path.isAbsolute(failure.path) &&
    typeof failure.key === "string" &&
    typeof failure.reason === "string" &&
    isLibrarySkipReason(failure.reasonCode)
  );
}

function isLibrarySkipReason(value: unknown): value is LibrarySkipReason {
  return (
    value === "scanned-pdf" ||
    value === "password-protected" ||
    value === "corrupt" ||
    value === "too-large" ||
    value === "empty" ||
    value === "unsupported" ||
    value === "unavailable" ||
    value === "capacity"
  );
}

function withoutKey(failure: PersistedLibraryFailure): LibrarySkippedFile {
  return {
    path: failure.path,
    reason: failure.reason,
    reasonCode: failure.reasonCode,
  };
}

function sameVersionedEntries(
  previous: readonly { readonly path: string; readonly key: string }[],
  next: readonly { readonly path: string; readonly key: string }[],
): boolean {
  return (
    previous.length === next.length &&
    previous.every((document, index) => document.path === next[index]?.path && document.key === next[index]?.key)
  );
}
