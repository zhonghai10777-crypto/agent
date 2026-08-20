import { expect, test } from "@playwright/test";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import {
  createChildThreadToolName,
  sendMessageToThreadToolName,
} from "../../electron/orchestration-runtime";
import { PLAN_BLOCKED_TOOLS, shouldBlockTool } from "../../electron/permission-mode";
import { createPermissionModeExtension } from "../../electron/permission-runtime";
import type { PermissionMode } from "@pi-gui/session-driver";

test("shouldBlockTool: auto mode never blocks", () => {
  for (const toolName of PLAN_BLOCKED_TOOLS) {
    expect(shouldBlockTool("auto", toolName), `auto/${toolName}`).toBeNull();
  }
});

test("shouldBlockTool: plan mode blocks mutating tools with a model-facing reason", () => {
  for (const toolName of PLAN_BLOCKED_TOOLS) {
    const result = shouldBlockTool("plan", toolName);
    expect(result, `plan/${toolName}`).not.toBeNull();
    expect(result!.block).toBe(true);
    // reason is a model-facing English message naming the tool (matching the
    // convention in document-runtime/web-runtime where ToolCallEventResult.reason
    // is aimed at the model, not the UI).
    expect(result!.reason).toContain(toolName);
  }
});

test("shouldBlockTool: plan mode lets read-only tools through", () => {
  expect(shouldBlockTool("plan", "read")).toBeNull();
  expect(shouldBlockTool("plan", "read_document")).toBeNull();
  expect(shouldBlockTool("plan", "web_search")).toBeNull();
  expect(shouldBlockTool("plan", "list_threads")).toBeNull();
});

test("shouldBlockTool: unknown tools fail open in plan mode, not starved", () => {
  // A tool pi added that this allowlist doesn't know about must not be silently
  // blocked — blocking would look like the tool is broken. Plan is opt-in, not
  // a security boundary.
  expect(shouldBlockTool("plan", "totally_made_up_tool")).toBeNull();
});

test("shouldBlockTool: create_child_thread is blocked via the orchestration constant, not a restated string", () => {
  // Guards against the tool name drifting in orchestration-runtime while this
  // allowlist keeps a stale literal.
  expect(PLAN_BLOCKED_TOOLS.has(createChildThreadToolName)).toBe(true);
  expect(shouldBlockTool("plan", createChildThreadToolName)?.block).toBe(true);
});

test("shouldBlockTool: send_message_to_thread is blocked via the orchestration constant", () => {
  // Sending or queueing a message mutates another thread and can indirectly
  // start writable work, so plan mode must not treat it as a read-only action.
  expect(PLAN_BLOCKED_TOOLS.has(sendMessageToThreadToolName)).toBe(true);
  expect(shouldBlockTool("plan", sendMessageToThreadToolName)?.block).toBe(true);
});

// ── createPermissionModeExtension: the hook actually wires shouldBlockTool ──
// The unit tests above cover the pure decision; this covers the integration
// point that is easiest to get subtly wrong (returning the block to pi vs
// throwing vs swallowing). Uses a fake ExtensionAPI so it stays a unit test —
// no Electron, no real provider.

function fakeToolCallEvent(toolName: string): ToolCallEvent {
  return {
    type: "tool_call",
    toolCallId: "call-1",
    toolName: toolName as never,
    input: {},
  } as unknown as ToolCallEvent;
}

function fakeCtx(): ExtensionContext {
  return {} as ExtensionContext;
}

function captureHandler(getMode: (ctx: ExtensionContext) => PermissionMode) {
  let registered: ((event: ToolCallEvent, ctx: ExtensionContext) => unknown) | undefined;
  const fakePi = {
    on(event: string, handler: unknown) {
      if (event === "tool_call") registered = handler as typeof registered;
    },
  } as unknown as ExtensionAPI;
  createPermissionModeExtension(getMode)(fakePi);
  if (!registered) throw new Error("permission extension did not register a tool_call handler");
  return registered;
}

test("createPermissionModeExtension: plan mode returns a block for write", () => {
  const handler = captureHandler(() => "plan");
  const result = handler(fakeToolCallEvent("write"), fakeCtx());
  expect(result).toEqual({
    block: true,
    reason: expect.stringContaining("write"),
  });
});

test("createPermissionModeExtension: auto mode returns undefined (allow)", () => {
  const handler = captureHandler(() => "auto");
  expect(handler(fakeToolCallEvent("write"), fakeCtx())).toBeUndefined();
  expect(handler(fakeToolCallEvent("bash"), fakeCtx())).toBeUndefined();
});

test("createPermissionModeExtension: read tools pass even in plan mode", () => {
  const handler = captureHandler(() => "plan");
  expect(handler(fakeToolCallEvent("read"), fakeCtx())).toBeUndefined();
  expect(handler(fakeToolCallEvent("read_document"), fakeCtx())).toBeUndefined();
});
