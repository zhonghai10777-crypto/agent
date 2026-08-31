import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PI_RUNTIME_VERSION,
  createAgentEventNormalizer,
  createStaticResourceLoader,
  createModelRuntime,
  findModel,
  listModels,
  modelSupportsImages,
  openSessionManager,
  resolveProviderAuth,
  setRuntimeApiKey,
} from "../dist/pi-compat/index.js";

const timestamp = "2026-08-31T00:00:00.000Z";

test("compat runtime exposes the approved Pi version and model capabilities", async () => {
  const runtime = await createModelRuntime({ modelsPath: null });
  const model = findModel(runtime, "openai-codex", "gpt-5.6-sol");

  assert.equal(PI_RUNTIME_VERSION, "0.84.4");
  assert.ok(model);
  assert.equal(modelSupportsImages(model), true);
  assert.ok(listModels(runtime).some((entry) => entry.provider === model.provider && entry.id === model.id));
});

test("compat auth adapter stores and resolves runtime API keys", async () => {
  const credentials = new Map();
  const runtime = await createModelRuntime({
    modelsPath: null,
    credentials: {
      async read(providerId) { return credentials.get(providerId); },
      async list() { return [...credentials].map(([providerId, credential]) => ({ providerId, type: credential.type })); },
      async modify(providerId, fn) {
        const next = await fn(credentials.get(providerId));
        if (next !== undefined) credentials.set(providerId, next);
        return next;
      },
      async delete(providerId) { credentials.delete(providerId); },
    },
  });

  await setRuntimeApiKey(runtime, "openai", "test-key");
  const auth = await resolveProviderAuth(runtime, "openai");
  assert.equal(auth?.auth.apiKey, "test-key");
});

test("event normalizer maps text and tool lifecycle events", () => {
  const normalizer = createAgentEventNormalizer();
  const assistant = { role: "assistant", content: [], api: "openai-responses", provider: "openai", model: "gpt-5", usage: {}, stopReason: "stop", timestamp: 0 };

  assert.deepEqual(normalizer.normalize({ type: "agent_start" }, { timestamp }), { type: "run-started", timestamp });
  assert.deepEqual(normalizer.normalize({ type: "message_update", message: assistant, assistantMessageEvent: { type: "text_delta", delta: "hello" } }, { timestamp }), { type: "assistant-delta", text: "hello", timestamp });
  assert.deepEqual(normalizer.normalize({ type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: { path: "a" } }, { timestamp }), { type: "tool-started", callId: "c1", toolName: "read", input: { path: "a" }, timestamp });
  assert.deepEqual(normalizer.normalize({ type: "tool_execution_update", toolCallId: "c1", toolName: "read", args: {}, partialResult: "half" }, { timestamp }), { type: "tool-updated", callId: "c1", detail: "half", timestamp });
  assert.deepEqual(normalizer.normalize({ type: "tool_execution_end", toolCallId: "c1", toolName: "read", result: "done", isError: false }, { timestamp }), { type: "tool-finished", callId: "c1", success: true, output: "done", timestamp });
});

test("event normalizer keeps retries non-terminal and emits one settled event", () => {
  const normalizer = createAgentEventNormalizer();
  const error = new Error("temporary");
  const retry = normalizer.normalize({ type: "agent_end", messages: [], willRetry: true }, { timestamp, success: false, error });
  assert.equal(retry?.type, "run-retrying");

  const settled = normalizer.normalize({ type: "agent_end", messages: [], willRetry: false }, { timestamp, success: true });
  assert.deepEqual(settled, { type: "run-settled", success: true, cancelled: false, timestamp });
  assert.equal(normalizer.normalize({ type: "agent_settled" }, { timestamp }), undefined);
  assert.equal(normalizer.normalize({ type: "turn_start" }, { timestamp }), undefined, "late events stay in the settled run");

  normalizer.reset();
  assert.deepEqual(normalizer.normalize({ type: "agent_settled" }, { timestamp }), { type: "run-settled", success: true, cancelled: false, timestamp });
});

test("markSettled blocks late events until the next run is reset", () => {
  const normalizer = createAgentEventNormalizer();
  normalizer.markSettled();
  assert.equal(normalizer.normalize({ type: "agent_start" }, { timestamp }), undefined);
  assert.equal(normalizer.normalize({ type: "tool_execution_start", toolCallId: "late", toolName: "read", args: {} }, { timestamp }), undefined);
  normalizer.reset();
  assert.deepEqual(normalizer.normalize({ type: "agent_start" }, { timestamp }), { type: "run-started", timestamp });
});

test("unknown Pi events are explicit and cannot become terminal state", () => {
  const normalizer = createAgentEventNormalizer();
  const event = { type: "future_event" };
  assert.deepEqual(normalizer.normalize(event, { timestamp }), { type: "unknown", sourceType: "future_event", timestamp });
});

test("static resource loader satisfies the Pi 0.84 resource contract", async () => {
  const loader = createStaticResourceLoader("compat prompt");
  await loader.reload();
  assert.equal(loader.getSystemPrompt(), "compat prompt");
  assert.equal(loader.getSystemPromptSource(), undefined);
  assert.deepEqual(loader.getAppendSystemPrompt(), []);
  assert.deepEqual(loader.getAppendSystemPromptSources(), []);
  assert.deepEqual(loader.getSkills(), { skills: [], diagnostics: [] });
});

test("session adapter opens a legacy versionless JSONL history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-compat-legacy-"));
  try {
    const file = join(dir, "legacy.jsonl");
    const header = { type: "session", id: "legacy-session", cwd: dir, timestamp };
    const userMessage = {
      type: "message",
      id: "legacy-user",
      parentId: null,
      timestamp,
      message: { role: "user", content: "legacy history", timestamp: Date.parse(timestamp) },
    };
    const assistantMessage = {
      type: "message",
      id: "legacy-assistant",
      parentId: "legacy-user",
      timestamp,
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "legacy reasoning" },
          { type: "toolCall", id: "legacy-call", name: "read", arguments: { path: "README.md" } },
        ],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "toolUse",
        timestamp: Date.parse(timestamp),
      },
    };
    const toolResult = {
      type: "message",
      id: "legacy-tool-result",
      parentId: "legacy-assistant",
      timestamp,
      message: { role: "toolResult", toolCallId: "legacy-call", toolName: "read", content: [{ type: "text", text: "result" }], isError: false, timestamp: Date.parse(timestamp) },
    };
    await writeFile(
      file,
      `${[header, userMessage, assistantMessage, toolResult].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    );

    const manager = openSessionManager(file);
    assert.equal(manager.getSessionId(), "legacy-session");
    assert.equal(typeof manager.getHeader()?.version, "number", "Pi migrates the legacy header in memory");
    assert.equal(manager.getEntries().length, 3);
    const messages = manager.buildSessionContext().messages;
    assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "toolResult"]);
    assert.ok(Array.isArray(messages[1]?.content));
    assert.ok(messages[1].content.some((part) => part.type === "thinking"));
    assert.ok(messages[1].content.some((part) => part.type === "toolCall" && part.id === "legacy-call"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
