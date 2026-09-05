import { windowsGitBashAvailable, type GitBashProbe } from "./windows-git-bash.js";

/**
 * pi's `bash` tool needs a POSIX shell. On Windows the only stock-compatible
 * one is Git Bash (`windows-git-bash.ts`): when it is present, sessions keep
 * pi's own default tool set and its bash tool. When it is not — a stock
 * machine has neither Git Bash nor a WSL distribution, only a
 * `System32\bash.exe` shim that fails opaquely — sessions run pi's
 * `powershell` tool instead: PowerShell ships with the OS, and pi names the
 * active shell in the tool description so the model emits PowerShell syntax.
 */

/** pi's built-in selection when a session passes no explicit tool list. */
const PI_DEFAULT_TOOL_NAMES = ["read", "bash", "edit", "write"] as const;

/** Built-in tools that run arbitrary commands, on any platform. */
const SHELL_TOOL_NAMES = ["bash", "powershell"] as const;

/**
 * Built-in tools light mode must never expose. Both shells are listed so light
 * mode stays command-free whichever shell the platform activates.
 */
export const LIGHT_MODE_EXCLUDED_TOOLS: readonly string[] = [...SHELL_TOOL_NAMES, "edit", "write"];

/**
 * Explicit built-in tool list for a new session, or `undefined` to let pi apply
 * its own default. Windows needs one only when no Git Bash was found, to swap
 * `bash` for `powershell`. `probe` is injectable for tests.
 */
export function sessionToolNames(probe?: GitBashProbe): string[] | undefined {
  if (process.platform !== "win32") {
    return undefined;
  }
  if (windowsGitBashAvailable(probe)) {
    // A real Git Bash exists and its bin dir now leads this process' PATH, so
    // pi's `where bash` resolves it over the WSL shim — keep the model on the
    // POSIX toolchain pi's bash tool is built for.
    return undefined;
  }
  return PI_DEFAULT_TOOL_NAMES.map((name) => (name === "bash" ? "powershell" : name));
}
