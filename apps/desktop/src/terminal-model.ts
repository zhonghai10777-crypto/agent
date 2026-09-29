export const TERMINAL_REPLAY_BUFFER_LENGTH = 1_000_000;

export interface TerminalReplayUpdate {
  readonly replay: string;
  readonly truncated: boolean;
}

export function appendTerminalReplay(
  replay: string,
  data: string,
  alreadyTruncated = false,
): TerminalReplayUpdate {
  const nextReplay = replay + data;
  if (nextReplay.length <= TERMINAL_REPLAY_BUFFER_LENGTH) {
    return { replay: nextReplay, truncated: alreadyTruncated };
  }

  return {
    replay: nextReplay.slice(-TERMINAL_REPLAY_BUFFER_LENGTH),
    truncated: true,
  };
}

/**
 * Off macOS a terminal reads Ctrl+C and Ctrl+V as control codes (an interrupt,
 * and readline's quoted-insert), so the clipboard needs keys of its own. As in
 * Windows Terminal: Ctrl+C copies while text is selected and interrupts
 * otherwise, Ctrl+Shift+C only ever copies, Ctrl+V and Ctrl+Shift+V paste. Alt
 * is left alone so AltGr layouts keep typing. macOS copies and pastes with Cmd,
 * which is no terminal key, so the browser's own handling works there.
 */
export function terminalClipboardShortcut(
  platform: NodeJS.Platform,
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">,
  hasSelection: boolean,
): "copy" | "paste" | undefined {
  if (platform === "darwin" || !event.ctrlKey || event.altKey || event.metaKey) {
    return undefined;
  }
  const key = event.key.toLowerCase();
  if (key === "v") {
    return "paste";
  }
  return key === "c" && (event.shiftKey || hasSelection) ? "copy" : undefined;
}
