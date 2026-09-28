import { expect, test } from "@playwright/test";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { FILE_MUTATION_TOOL_NAMES, READ_ONLY_TOOL_NAMES, SHELL_TOOL_NAMES, sessionToolNames } from "@pi-gui/pi-sdk-driver/windows-shell";
import { createChildThreadToolName, sendMessageToThreadToolName } from "../../electron/orchestration-runtime";
import { officeToolNames } from "../../electron/office-runtime";
import { composeMutatingToolNames } from "../../electron/office-compose";
import { PLAN_ALLOWED_TOOLS, shouldBlockTool } from "../../electron/permission-mode";
import { createPermissionModeExtension } from "../../electron/permission-runtime";
import type { PermissionMode } from "@pi-gui/session-driver";

// Every tool the app or pi might run that changes something.
const WRITING_TOOLS = [
  ...SHELL_TOOL_NAMES,
  ...FILE_MUTATION_TOOL_NAMES,
  createChildThreadToolName,
  sendMessageToThreadToolName,
  ...officeToolNames,
  ...composeMutatingToolNames,
];

test("shouldBlockTool: auto mode never blocks", () => {
  for (const toolName of [...WRITING_TOOLS, ...PLAN_ALLOWED_TOOLS, "some_extension_tool"]) {
    expect(shouldBlockTool("auto", toolName), `auto/${toolName}`).toBeNull();
  }
});

test("shouldBlockTool: plan mode blocks writing tools with a model-facing reason", () => {
  for (const toolName of WRITING_TOOLS) {
    const result = shouldBlockTool("plan", toolName);
    expect(result, `plan/${toolName}`).not.toBeNull();
    expect(result!.block).toBe(true);
    // reason is a model-facing English message naming the tool (matching the
    // convention in document-runtime/web-runtime where ToolCallEventResult.reason
    // is aimed at the model, not the UI).
    expect(result!.reason).toContain(toolName);
  }
});

test("shouldBlockTool: plan mode blocks every shell tool, not just bash", () => {
  // Windows swaps pi's `bash` tool for `powershell` when no Git Bash is
  // installed (`windows-shell.ts`).
  for (const shell of ["bash", "powershell"]) {
    expect(shouldBlockTool("plan", shell)?.block, `plan/${shell}`).toBe(true);
  }
});

test("shouldBlockTool: plan blocks whatever writing tool the platform actually activates", () => {
  // Ties the policy to the tool set a Windows session runs with: any active
  // built-in that is not read-only must be blocked in plan mode.
  const active = sessionToolNames({ registryInstallPaths: () => [], gitExecutableFromPath: () => undefined })
    ?? ["read", "bash", "edit", "write"];
  const unblocked = active.filter((name) => !READ_ONLY_TOOL_NAMES.includes(name) && !shouldBlockTool("plan", name));
  expect(unblocked, "every mutating built-in a session activates must be blocked in plan mode").toEqual([]);
});

test("shouldBlockTool: plan mode blocks every Office writer", () => {
  for (const name of officeToolNames) {
    expect(shouldBlockTool("plan", name)?.block, `plan/${name}`).toBe(true);
  }
});

test("shouldBlockTool: plan mode lets every known read-only tool through", () => {
  for (const name of [
    ...READ_ONLY_TOOL_NAMES,
    "read_document",
    "library_search",
    "library_list",
    "web_search",
    "web_fetch",
    "web_read",
    "list_threads",
    "read_thread",
    "inspect_images",
    "word_template_inspect",
  ]) {
    expect(shouldBlockTool("plan", name), `plan/${name}`).toBeNull();
  }
});

test("shouldBlockTool: plan mode blocks tools it does not know, such as third-party extension tools", () => {
  // Plan means "don't change anything": a tool not known to be read-only may
  // write, so it is refused (with a reason the model relays) rather than trusted.
  const result = shouldBlockTool("plan", "some_extension_tool");
  expect(result?.block).toBe(true);
  expect(result?.reason).toContain("some_extension_tool");
});

test("shouldBlockTool: thread delegation is blocked via the orchestration constants, not restated strings", () => {
  expect(shouldBlockTool("plan", createChildThreadToolName)?.block).toBe(true);
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

test("createPermissionModeExtension: plan blocks shell, file and Office writes", () => {
  const handler = captureHandler(() => "plan");
  for (const name of ["bash", "powershell", "write", "edit", ...officeToolNames]) {
    expect(handler(fakeToolCallEvent(name), fakeCtx())).toEqual({
      block: true,
      reason: expect.stringContaining(name),
    });
  }
});

test("createPermissionModeExtension: auto mode returns undefined (allow)", () => {
  const handler = captureHandler(() => "auto");
  expect(handler(fakeToolCallEvent("write"), fakeCtx())).toBeUndefined();
  expect(handler(fakeToolCallEvent("bash"), fakeCtx())).toBeUndefined();
  expect(handler(fakeToolCallEvent("powershell"), fakeCtx())).toBeUndefined();
});

test("createPermissionModeExtension: read tools pass even in plan mode", () => {
  const handler = captureHandler(() => "plan");
  expect(handler(fakeToolCallEvent("read"), fakeCtx())).toBeUndefined();
  expect(handler(fakeToolCallEvent("read_document"), fakeCtx())).toBeUndefined();
});
