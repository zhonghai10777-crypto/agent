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
