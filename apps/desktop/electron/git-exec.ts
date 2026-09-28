import { execFile } from "node:child_process";

export interface GitExecOptions {
  readonly cwd?: string;
  readonly maxBuffer?: number;
}

export interface GitExecResult {
  readonly error: Error | null;
  readonly stdout: string;
}

/**
 * The one way the app runs git, so every call gets `windowsHide`: without it a
 * console window flashes up per call on Windows, where a GUI process has no
 * console to share. Never rejects - a failed command reports its error next
 * to whatever it printed (`git diff --no-index` exits 1 with the diff on stdout).
 */
export function execGit(args: readonly string[], options: GitExecOptions = {}): Promise<GitExecResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      [...args],
      {
        encoding: "utf8",
        windowsHide: true,
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.maxBuffer ? { maxBuffer: options.maxBuffer } : {}),
      },
      (error, stdout) => resolve({ error, stdout }),
    );
  });
}
