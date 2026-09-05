import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";

/**
 * pi runs the Windows powershell tool profile-less and console-less
 * (`-NoProfile -NonInteractive`, hidden window, piped stdio), so PowerShell
 * writes output in the system OEM code page — 936/GBK on zh-CN Windows — while
 * pi decodes tool output as UTF-8. Chinese from cmdlets, native commands, and
 * UTF-8-emitting programs alike reaches the model as mojibake, and
 * `Get-Content` decodes BOM-less UTF-8 files (everything pi's write tool
 * produces) as ANSI on top.
 *
 * Mutating `tool_call` input in place is pi's sanctioned way to adjust tool
 * arguments, so this preamble rides in ahead of every powershell command and
 * forces UTF-8 for output and default file reads. Explicit `-Encoding`
 * parameters still win over `$PSDefaultParameterValues`, and the newline join
 * mirrors pi's own bash `commandPrefix` handling: the model's command is never
 * re-quoted, only preceded by two silent setup statements.
 */
export const POWERSHELL_ENCODING_PREAMBLE =
  "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $PSDefaultParameterValues['Get-Content:Encoding']='utf8';";

export function withPowerShellEncodingPreamble(command: string): string {
  const trimmed = command.trimStart();
  if (!trimmed || trimmed.startsWith(POWERSHELL_ENCODING_PREAMBLE)) {
    return command;
  }
  return `${POWERSHELL_ENCODING_PREAMBLE}\n${command}`;
}

/**
 * Returns undefined off Windows, where pi never activates the powershell tool
 * (sessions use its bash tool instead), so callers can spread the result into
 * an extension list without changing macOS/Linux behavior.
 */
export function windowsPowerShellEncodingExtensionFactory(): ExtensionFactory | undefined {
  if (process.platform !== "win32") {
    return undefined;
  }
  return (pi: ExtensionAPI) => {
    pi.on("tool_call", (event) => {
      if (event.toolName !== "powershell") {
        return;
      }
      if (typeof event.input.command === "string") {
        event.input.command = withPowerShellEncodingPreamble(event.input.command);
      }
    });
  };
}
