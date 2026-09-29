import path from "node:path";

/**
 * The integrated terminal's environment: this process' own, set up for xterm,
 * minus `omittedNames` (variables the app sets only for the agent's shell tools).
 */
export function buildTerminalEnv(
  omittedNames: readonly string[] = [],
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  env.TERM = "xterm-256color";
  for (const name of ["TERMINFO", "TERMINFO_DIRS", ...omittedNames]) {
    delete env[name];
  }
  return env;
}

export interface TerminalShellLaunch {
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/**
 * How to start `shellPath` in the integrated terminal. A bash on Windows (Git
 * Bash, the default there) starts as a login shell, the way VS Code starts it:
 * without --login it skips /etc/profile and with it Git's prompt, completion and
 * the user's ~/.bash_profile. CHERE_INVOKING keeps a login shell in the
 * terminal's working directory instead of the $HOME an MSYS profile moves to.
 */
export function terminalShellLaunch(shellPath: string, platform: NodeJS.Platform = process.platform): TerminalShellLaunch {
  if (platform === "win32" && /^bash(?:\.exe)?$/iu.test(path.win32.basename(shellPath))) {
    return { args: ["--login", "-i"], env: { CHERE_INVOKING: "1" } };
  }
  return { args: [], env: {} };
}
