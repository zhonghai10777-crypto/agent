import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

/**
 * Git for Windows is the only stock-compatible source of a POSIX bash: pi's
 * bash tool resolves `bash` through `where` (PATH order), and on an untouched
 * machine the first hit is `System32\bash.exe` — the WSL shim that fails
 * opaquely without an installed distribution, and that wins even when Git is
 * installed, because the default installer only puts `Git\cmd` on PATH while
 * bash.exe lives in `Git\bin`. Detection therefore walks the installer's own
 * breadcrumbs instead of trusting PATH: well-known install roots, the
 * GitForWindows registry key, and the directory layout around whichever
 * `git.exe` is on PATH.
 */

const GIT_BASH_ENV_OVERRIDE = "PI_GIT_BASH";
const REGISTRY_KEYS = ["HKLM\\SOFTWARE\\GitForWindows", "HKCU\\SOFTWARE\\GitForWindows"] as const;

/**
 * The lookups filesystem probing can fall back to. Spawn-based, so tests and
 * embedders inject stubs instead of touching the registry.
 */
export interface GitBashProbe {
  readonly registryInstallPaths: () => readonly string[];
  readonly gitExecutableFromPath: () => string | undefined;
}

function registryInstallPaths(): readonly string[] {
  const found: string[] = [];
  for (const key of REGISTRY_KEYS) {
    try {
      const result = spawnSync("reg", ["query", key, "/v", "InstallPath"], {
        encoding: "utf-8",
        timeout: 5000,
        windowsHide: true,
      });
      const match = /InstallPath\s+REG_SZ\s+(.+)/i.exec(result.stdout ?? "");
      if (match?.[1]) {
        found.push(match[1].trim());
      }
    } catch {
      // reg.exe missing or the key absent — the probe just stays empty.
    }
  }
  return found;
}

function gitExecutableFromPath(): string | undefined {
  try {
    const result = spawnSync("where", ["git"], { encoding: "utf-8", timeout: 5000, windowsHide: true });
    const first = (result.stdout ?? "").trim().split(/\r?\n/)[0];
    return first && existsSync(first) ? first : undefined;
  } catch {
    return undefined;
  }
}

const defaultProbe: GitBashProbe = { registryInstallPaths, gitExecutableFromPath };

function bashUnderInstallRoot(root: string): string | undefined {
  const bash = join(root, "bin", "bash.exe");
  return existsSync(bash) ? bash : undefined;
}

/**
 * Locates Git Bash without consulting PATH order (`PI_GIT_BASH` wins when set
 * to an existing file). Pure: no PATH side effects, see
 * `windowsGitBashAvailable`.
 */
export function findGitBashWindows(
  env: NodeJS.ProcessEnv = process.env,
  probe: GitBashProbe = defaultProbe,
): string | undefined {
  const override = env[GIT_BASH_ENV_OVERRIDE]?.trim();
  if (override && existsSync(override)) {
    return override;
  }

  const installRoots = [
    env.ProgramFiles,
    env["ProgramFiles(x86)"],
    env.LocalAppData ? join(env.LocalAppData, "Programs", "Git") : undefined,
    ...probe.registryInstallPaths(),
  ];
  for (const root of installRoots) {
    if (!root) {
      continue;
    }
    const bash = bashUnderInstallRoot(root);
    if (bash) {
      return bash;
    }
  }

  const git = probe.gitExecutableFromPath();
  if (git) {
    const gitDir = dirname(git);
    // `<root>\cmd\git.exe` (the installer's PATH default) or
    // `<root>\bin\git.exe`; bash.exe sits in `<root>\bin`.
    for (const candidate of [join(dirname(gitDir), "bin", "bash.exe"), join(gitDir, "bash.exe")]) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

interface GitBashDetection {
  readonly bashPath: string | undefined;
}

let cachedDetection: GitBashDetection | undefined;

function detectGitBash(probe: GitBashProbe): GitBashDetection {
  if (!cachedDetection) {
    const bashPath = process.platform === "win32" ? findGitBashWindows(undefined, probe) : undefined;
    cachedDetection = { bashPath };
    if (bashPath) {
      putGitBinFirstOnPath(dirname(bashPath));
    }
  }
  return cachedDetection;
}

/**
 * Whether this process can run pi's bash tool. Detects once per process and,
 * when Git Bash is found, puts its `bin` directory at the front of this
 * process' PATH so pi's `where bash` resolves Git's bash.exe over the WSL shim
 * — the process-local equivalent of the PATH reordering Git Bash needs, with
 * no system settings touched.
 */
export function windowsGitBashAvailable(probe?: GitBashProbe): boolean {
  return detectGitBash(probe ?? defaultProbe).bashPath !== undefined;
}

/** The detected Git Bash, cached and PATH-fixed exactly like `windowsGitBashAvailable`. */
export function windowsGitBashPath(probe?: GitBashProbe): string | undefined {
  return detectGitBash(probe ?? defaultProbe).bashPath;
}

/** Detection caches once per process; tests reset it to re-detect under fixture environments. */
export function resetGitBashDetectionCache(): void {
  cachedDetection = undefined;
}

function putGitBinFirstOnPath(binDir: string): void {
  const entries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const normalizedBinDir = binDir.toLowerCase();
  const system32Index = entries.findIndex((entry) => entry.toLowerCase().includes("system32"));
  const existingIndex = entries.findIndex((entry) => entry.toLowerCase() === normalizedBinDir);
  if (existingIndex >= 0 && (system32Index < 0 || existingIndex < system32Index)) {
    // Already ahead of System32, so `where bash` cannot hit the WSL shim first.
    return;
  }
  process.env.PATH = [binDir, ...entries.filter((entry) => entry.toLowerCase() !== normalizedBinDir)].join(delimiter);
}
