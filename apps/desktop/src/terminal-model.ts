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
 * Off macOS a terminal reads Ctrl+C as an interrupt, so copying needs a rule of
 * its own, the one Windows Terminal uses: Ctrl+C copies while text is selected
 * and interrupts otherwise, and Ctrl+Shift+C only ever copies. macOS copies with
 * Cmd+C, which is no terminal key, so the browser's own copy works there.
 */
export function isTerminalCopyShortcut(
  platform: NodeJS.Platform,
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">,
  hasSelection: boolean,
): boolean {
  return (
    platform !== "darwin" &&
    event.ctrlKey &&
    !event.altKey &&
    !event.metaKey &&
    event.key.toLowerCase() === "c" &&
    (event.shiftKey || hasSelection)
  );
}
