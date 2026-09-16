import { execFile } from "node:child_process";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { WorkspaceFileListResult, WorkspaceFilePreview } from "../src/ipc";
import { resolveExistingWorkspacePath } from "./workspace-paths";

const fileCache = new Map<string, WorkspaceFileListResult & { timestamp: number }>();
const CACHE_TTL_MS = 30_000;
const CACHE_MAX_ENTRIES = 20;
const MAX_PREVIEW_BYTES = 200 * 1024;

// Bounds for the non-git fallback walk below — chosen to cover an ordinary project
// without letting one huge or deeply-nested directory (or a git binary that's
// missing/broken) block the mention/diff file list indefinitely.
const WALK_MAX_DEPTH = 16;
const WALK_MAX_FILES = 10_000;
const WALK_MAX_VISITED = 20_000;

export async function listWorkspaceFiles(
  workspacePath: string,
  options: { readonly force?: boolean } = {},
): Promise<WorkspaceFileListResult> {
  const cached = fileCache.get(workspacePath);
  if (!options.force && cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return { files: cached.files, truncated: cached.truncated };
  }

  const result = (await listFilesViaGit(workspacePath)) ?? (await listFilesViaWalk(workspacePath));

  if (fileCache.size >= CACHE_MAX_ENTRIES) {
    const oldest = fileCache.keys().next().value;
    if (oldest !== undefined) {
      fileCache.delete(oldest);
    }
  }
  fileCache.set(workspacePath, { ...result, timestamp: Date.now() });
  return result;
}

/** `git ls-files` is the primary source (it's fast and respects .gitignore). Returns
 * `null` — rather than an empty result — on any failure, so the caller falls back to
 * a real directory walk instead of silently reporting "no files" for a workspace that
 * simply isn't a git repo (e.g. the built-in personal workspace) or whose tracked-file
 * list exceeds the output buffer. */
function listFilesViaGit(workspacePath: string): Promise<WorkspaceFileListResult | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard"],
      { cwd: workspacePath, maxBuffer: 5 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        const files = stdout
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .sort();
        resolve({ files, truncated: false });
      },
    );
  });
}

/** Bounded filesystem walk used when the workspace isn't a git repo (or git failed).
 * A capped, best-effort listing beats an empty one: a mention/diff menu that always
 * shows nothing gives the user no way to tell "no files" apart from "couldn't check". */
async function listFilesViaWalk(workspacePath: string): Promise<WorkspaceFileListResult> {
  const files: string[] = [];
  let truncated = false;
  let visited = 0;

  const walk = async (directory: string, relativeDir: string, depth: number): Promise<void> => {
    if (truncated) {
      return;
    }
    if (depth > WALK_MAX_DEPTH) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      // Unreadable subdirectory (permissions, deleted mid-scan, etc). A partial
      // listing beats failing the whole scan over one bad directory.
      return;
    }
    for (const entry of entries) {
      if (truncated) {
        return;
      }
      visited += 1;
      if (visited > WALK_MAX_VISITED || files.length >= WALK_MAX_FILES) {
        truncated = true;
        return;
      }
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) {
        continue;
      }
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(join(directory, entry.name), relativePath, depth + 1);
        continue;
      }
      if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  };

  await walk(workspacePath, "", 0);
  files.sort();
  return { files, truncated };
}

export async function readWorkspaceFile(workspacePath: string, filePath: string): Promise<WorkspaceFilePreview> {
  const resolved = await resolveExistingWorkspacePath(workspacePath, filePath);
  const handle = await open(resolved, "r");
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      return {
        path: filePath,
        content: "",
        truncated: false,
        binary: true,
        sizeBytes: stats.size,
      };
    }

    const readLength = Math.min(stats.size, MAX_PREVIEW_BYTES + 1);
    const buffer = Buffer.alloc(readLength);
    const { bytesRead } = await handle.read(buffer, 0, readLength, 0);
    const previewBytes = buffer.subarray(0, Math.min(bytesRead, MAX_PREVIEW_BYTES));
    const binary = previewBytes.includes(0);

    return {
      path: filePath,
      content: binary ? "" : new TextDecoder("utf-8", { fatal: false }).decode(previewBytes),
      truncated: bytesRead > MAX_PREVIEW_BYTES || stats.size > MAX_PREVIEW_BYTES,
      binary,
      sizeBytes: stats.size,
    };
  } finally {
    await handle.close();
  }
}
