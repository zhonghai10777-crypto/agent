/**
 * Lightweight permission modes for the desktop agent.
 *
 * pi does not gate its own built-in write/edit/bash tools, and the desktop
 * surface is aimed at non-programmer engineers who often run read-only
 * "look something up" sessions. The two modes here add an explicit read-only
 * gear without forking pi: an extension subscribes to pi's pre-execution
 * `tool_call` event (see `permission-runtime.ts`) and, when the active session
 * is in `plan` mode, blocks every tool not known to be read-only, returning a
 * reason the model relays to the user instead of throwing.
 *
 * Default is `auto` (the session is writable). `plan` is an opt-in "this turn
 * should only read, not change anything" gear — chosen for default-writable so
 * the normal flow stays frictionless.
 *
 * `DEFAULT_PERMISSION_MODE` lives in the shared type package so the renderer
 * (state projection), the main process (permission logic) and the extension
 * provider all read one source of truth for the default.
 */
import { READ_ONLY_TOOL_NAMES } from "@pi-gui/pi-sdk-driver/windows-shell";
import { readDocumentToolName } from "./document-runtime";
import { inspectImagesToolName } from "./image-inspection-runtime";
import { libraryListToolName, librarySearchToolName } from "./library-runtime";
import { composeMutatingToolNames, composeToolNames } from "./office-compose";
import { listThreadsToolName, readThreadToolName } from "./orchestration-runtime";
import { webFetchToolName, webReadToolName, webSearchToolName } from "./web-runtime";
import type { PermissionMode, SessionRef } from "@pi-gui/session-driver";
import type { AppStoreInternals } from "./app-store-internals";

/**
 * Tool names `plan` mode lets through; every other tool is blocked.
 *
 * Plan mode means "look, don't change anything", so it is an allowlist rather
 * than a list of known writers: a tool this list does not know - including any
 * tool a third-party extension registers - may write, and is refused with a
 * reason the model relays. Names come from the owning modules.
 */
export const PLAN_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  ...READ_ONLY_TOOL_NAMES,
  readDocumentToolName,
  librarySearchToolName,
  libraryListToolName,
  webSearchToolName,
  webFetchToolName,
  webReadToolName,
  listThreadsToolName,
  readThreadToolName,
  inspectImagesToolName,
  ...composeToolNames.filter((name) => !(composeMutatingToolNames as readonly string[]).includes(name)),
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
  if (mode === "plan" && !PLAN_ALLOWED_TOOLS.has(toolName)) {
    return {
      block: true,
      reason: `Read-only (plan) mode blocks ${toolName}. Switch the session to auto mode to modify files or run commands.`,
    };
  }
  return null;
}

/** Rechecked at model dispatch; user composer actions use separate entry points. */
export function assertModelDelegationAllowed(
  store: Pick<AppStoreInternals, "sessionFromState" | "sessionPermissionMode" | "assertCapability">,
  caller: SessionRef,
  toolName: string,
): void {
  if (!store.sessionFromState(caller)) {
    throw new Error(`Unable to resolve calling session: ${caller.workspaceId}:${caller.sessionId}. Delegation denied.`);
  }
  store.assertCapability("childAgents");
  const block = shouldBlockTool(store.sessionPermissionMode(caller), toolName);
  if (block) throw new Error(block.reason);
}
