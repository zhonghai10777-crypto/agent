import type { AppView } from "../desktop-state";
import { MODAL_DIALOG_SELECTOR } from "../dialog-focus";

export function isEventInsideTerminal(event: globalThis.KeyboardEvent): boolean {
  const target = event.target;
  return target instanceof Element && Boolean(target.closest("[data-pi-terminal]"));
}

/** True while the event's target is a short-lived inline text field — e.g. the session/workspace
 * rename `<input>` in the sidebar — so app-level shortcuts can avoid stealing focus from it.
 * Deliberately excludes `<textarea>`: the composer is the app's dominant textarea, the user is in
 * it most of the time, and it already owns its own keydown handling — treating "focused in the
 * composer" as "editing text, hands off" would block Cmd+F/Cmd+D from their most common context. */
export function isEventInsideTextEntry(event: globalThis.KeyboardEvent): boolean {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return target.tagName === "INPUT" || target.isContentEditable;
}

/** True while a modal dialog is open. Shares MODAL_DIALOG_SELECTOR with
 * `restoreTopmostDialogFocus` in dialog-focus.ts, so the two stay in sync. */
export function hasOpenModalDialog(): boolean {
  return document.querySelector(MODAL_DIALOG_SELECTOR) !== null;
}

export function canTogglePrimarySidebar(view: AppView | undefined): boolean {
  return view === "threads" || view === "new-thread";
}
