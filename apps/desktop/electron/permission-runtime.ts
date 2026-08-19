import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import type { PermissionMode } from "@pi-gui/session-driver";
import { shouldBlockTool } from "./permission-mode";

/**
 * Resolves the active permission mode for the session that owns a tool call.
 *
 * Resolved per call from the live store, never captured at registration:
 * extensions are built once per workspace and shared by every session in it,
 * so a mode fixed at registration could not differ between a session the user
 * set to "plan" and one left at "auto". Mirrors the per-call scope resolution
 * in `document-runtime.ts` (`DocumentAccessProvider`).
 */
export type PermissionModeProvider = (ctx: ExtensionContext) => PermissionMode;

/**
 * Extension that gates mutating tools (write/edit/bash/create_child_thread) in
 * `plan` mode by subscribing to pi's pre-execution `tool_call` event.
 *
 * Uses pi's native `block`/`reason` result rather than `setActiveTools` /
 * the `tools` allowlist: hiding a tool from the model leaves it guessing why
 * it cannot write, while a blocked call with a reason is something the model
 * relays to the user — matching the repo's "errors are messages, not faults"
 * convention (`web-runtime.ts`, `document-runtime.ts`).
 */
export function createPermissionModeExtension(
  getMode: PermissionModeProvider,
): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.on("tool_call", (event: ToolCallEvent, ctx: ExtensionContext): ToolCallEventResult | void => {
      const block = shouldBlockTool(getMode(ctx), event.toolName);
      if (block) {
        return block;
      }
      return undefined;
    });
  };
}
