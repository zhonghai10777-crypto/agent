/**
 * pi's `bash` tool needs a POSIX shell. On Windows that means Git Bash or a WSL
 * distribution, and a stock machine has neither — Windows only ships a
 * `System32\bash.exe` shim that forwards to WSL and fails opaquely without an
 * installed distribution. Windows sessions therefore run pi's `powershell` tool
 * instead: PowerShell ships with the OS, and pi names the active shell in the
 * tool description so the model emits PowerShell syntax rather than bash.
 */

/** pi's built-in selection when a session passes no explicit tool list. */
const PI_DEFAULT_TOOL_NAMES = ["read", "bash", "edit", "write"] as const;

/** Built-in tools that run arbitrary commands, on any platform. */
const SHELL_TOOL_NAMES = ["bash", "powershell"] as const;

/**
 * Built-in tools light mode must never expose. Both shells are listed so light
 * mode stays command-free whichever shell the host platform activates.
 */
export const LIGHT_MODE_EXCLUDED_TOOLS: readonly string[] = [...SHELL_TOOL_NAMES, "edit", "write"];

/**
 * Explicit built-in tool list for a new session, or `undefined` to let pi apply
 * its own default. Only Windows needs one, to swap `bash` for `powershell`.
 */
export function sessionToolNames(): string[] | undefined {
  if (process.platform !== "win32") {
    return undefined;
  }
  return PI_DEFAULT_TOOL_NAMES.map((name) => (name === "bash" ? "powershell" : name));
}
