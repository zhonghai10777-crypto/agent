/**
 * Lightweight permission modes for the desktop agent.
 *
 * pi does not gate its own built-in write/edit/bash tools, and the desktop
 * surface is aimed at non-programmer engineers who often run read-only
 * "look something up" sessions. The two modes here add an explicit read-only
 * gear without forking pi: an extension subscribes to pi's pre-execution
 * `tool_call` event (see `permission-runtime.ts`) and blocks the mutating
 * tools when the active session is in `plan` mode, returning a reason the
 * model relays to the user instead of throwing.
 *
 * Default is `auto` (the session is writable). `plan` is an opt-in "this turn
 * should only read, not change anything" gear — chosen for default-writable so
 * the normal flow stays frictionless.
 *
 * `DEFAULT_PERMISSION_MODE` lives in the shared type package so the renderer
 * (state projection), the main process (permission logic) and the extension
 * provider all read one source of truth for the default.
 */
import { createChildThreadToolName } from "./orchestration-runtime";
import type { PermissionMode } from "@pi-gui/session-driver";

/**
 * Tool names blocked in `plan` mode. `write`/`edit`/`bash` are pi's built-in
 * tool `toolName` values (`tools/write|edit|bash.d.ts`); `create_child_thread`
 * is the orchestration tool registered in `orchestration-runtime.ts` — pulled
 * from its constant rather than restated so the two stay in sync. Read-only
 * tools (`read`, `grep`, `find`, `ls`, `read_document`, `web_search`,
 * `web_fetch`, `list_threads`, `read_thread`) stay available so the agent can
 * still investigate.
 */
export const PLAN_BLOCKED_TOOLS: ReadonlySet<string> = new Set([
  "write",
  "edit",
  "bash",
  createChildThreadToolName,
]);

export interface ToolBlock {
  readonly block: true;
  readonly reason: string;
}

/**
 * Decide whether a tool call should be blocked before execution.
 *
 * Returns a `{ block, reason }` the `tool_call` handler returns to stop the
 * call (pi surfaces `reason` to the model), or `null` to let it proceed. The
 * reason is an English message aimed at the model — matching the convention in
 * `document-runtime.ts`/`web-runtime.ts`/`orchestration-runtime.ts` where
 * `ToolCallEventResult.reason` is a model-facing message and user-visible
 * copy lives in i18n. Kept a pure function so it is trivial to unit-test
 * (see `tests/unit/permission.spec.ts`).
 */
export function shouldBlockTool(
  mode: PermissionMode,
  toolName: string,
): ToolBlock | null {
  if (mode === "plan" && PLAN_BLOCKED_TOOLS.has(toolName)) {
    return {
      block: true,
      reason: `Read-only (plan) mode blocks ${toolName}. Switch the session to auto mode to modify files or run commands.`,
    };
  }
  return null;
}
