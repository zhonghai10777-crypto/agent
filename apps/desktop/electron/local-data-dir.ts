import { mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { isPathWithinRoot } from "./document-access";

/**
 * Where bulky, machine-local data lives: git worktrees (whole checkouts) and
 * the rebuildable library index. On Windows userData defaults to %APPDATA%, the
 * roaming profile that domain accounts copy to a server at every logon and
 * logoff, so data there moves to the same place under %LOCALAPPDATA%. A userData
 * outside the roaming profile (an explicit profile directory) keeps it.
 */
export function resolveLocalDataDir(
  userDataDir: string,
  env: NodeJS.ProcessEnv = process.env,
  paths: typeof path = path,
): string {
  const roaming = env.APPDATA;
  const local = env.LOCALAPPDATA;
  if (!roaming || !local || !isPathWithinRoot(userDataDir, roaming, paths)) {
    return userDataDir;
  }
  return paths.join(local, paths.relative(roaming, userDataDir));
}

/**
 * Moves a directory to its new home unless one is already there. Best-effort:
 * if the move fails the old copy stays where it was and the caller starts afresh.
 */
export async function moveDirectoryIfAbsent(from: string, to: string): Promise<void> {
  if (from === to || (await exists(to)) || !(await exists(from))) {
    return;
  }
  try {
    await mkdir(path.dirname(to), { recursive: true });
    await rename(from, to);
  } catch (error) {
    console.warn(`pi-gui: kept ${from} in place: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function exists(target: string): Promise<boolean> {
  return stat(target).then(
    () => true,
    () => false,
  );
}
