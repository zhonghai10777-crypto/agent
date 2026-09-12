import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { documentVersion } from "./document-file";

export interface DocumentAccessScope {
  readonly workspaceRoots: readonly string[];
  readonly allowedFiles: readonly string[];
}

export type DocumentAccessErrorCode = "DOCUMENT_UNAUTHORIZED" | "DOCUMENT_NOT_FOUND" | "DOCUMENT_UNREADABLE";

export class DocumentAccessError extends Error {
  constructor(readonly code: DocumentAccessErrorCode, message: string) { super(message); }
}

/** Lexical relation for already canonical paths; '..notes.txt' is a valid child. */
export function isPathWithinRoot(target: string, root: string, paths: typeof path = path): boolean {
  const relative = paths.relative(paths.resolve(root), paths.resolve(target));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative);
}

/** Resolve both sides of authorization. Never read the original, unchecked path.
 * This constrains app reads, not hostile local processes: an ancestor can still
 * be replaced between realpath and open. The cache/worker checks file identity
 * again on the opened handle to narrow that race. */
export async function authorizeDocumentPath(target: string, scope: DocumentAccessScope): Promise<string> {
  return (await authorizeDocumentRead(target, scope)).path;
}

export async function authorizeDocumentRead(target: string, scope: DocumentAccessScope): Promise<{ path: string; sourceVersion: string }> {
  let canonical: string;
  let sourceVersion: string;
  try {
    canonical = await realpath(target);
    const info = await stat(canonical);
    if (!info.isFile()) throw new Error("Not a regular file");
    sourceVersion = documentVersion(canonical, info);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new DocumentAccessError("DOCUMENT_NOT_FOUND", "The document does not exist or its link is broken.");
    }
    throw new DocumentAccessError("DOCUMENT_UNREADABLE", "The document cannot currently be read.");
  }
  for (const file of scope.allowedFiles) {
    if (await canonicalOrUndefined(file) === canonical) return { path: canonical, sourceVersion };
  }
  for (const root of scope.workspaceRoots) {
    const canonicalRoot = await canonicalOrUndefined(root);
    if (canonicalRoot && isPathWithinRoot(canonical, canonicalRoot)) return { path: canonical, sourceVersion };
  }
  throw new DocumentAccessError("DOCUMENT_UNAUTHORIZED",
    "That file is outside the current workspace and was not attached to this conversation, so it cannot be read. Ask the user to attach it.");
}

async function canonicalOrUndefined(input: string): Promise<string | undefined> {
  try { return await realpath(input); } catch { return undefined; }
}
