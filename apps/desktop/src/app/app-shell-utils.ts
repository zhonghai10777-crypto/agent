import type { AppView } from "../desktop-state";

export function isEventInsideTerminal(event: globalThis.KeyboardEvent): boolean {
  const target = event.target;
  return target instanceof Element && Boolean(target.closest("[data-pi-terminal]"));
}

/** True while the event's target is a live text entry (input/textarea/contenteditable) — e.g. an
 * inline rename field — so app-level shortcuts can avoid stealing focus from it. */
export function isEventInsideTextEntry(event: globalThis.KeyboardEvent): boolean {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.isContentEditable
  );
}

/** True while a modal dialog is open. Uses the same `[aria-modal='true']` selector as
 * `restoreTopmostDialogFocus` in dialog-focus.ts, so the two stay in sync. */
export function hasOpenModalDialog(): boolean {
  return document.querySelector("[aria-modal='true']") !== null;
}

export function canTogglePrimarySidebar(view: AppView | undefined): boolean {
  return view === "threads" || view === "new-thread";
}
