/**
 * Shared by driver tests that need a real pi AgentSession under a
 * SessionSupervisor, driven by a scripted fake provider.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime, SessionManager, SettingsManager, createAgentSession } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createCompatResourceLoader } from "../dist/pi-compat/resource-loader-adapter.js";
import { SessionSupervisor } from "../dist/session-supervisor.js";
import { JsonCatalogStore } from "../dist/json-catalog-store.js";

const model = {
  id: "streaming-test-model",
  name: "Streaming Test Model",
  provider: "streaming-test",
  api: "openai-completions",
  baseUrl: "https://example.invalid",
  reasoning: false,
  input: ["text"],
  contextWindow: 200_000,
  maxTokens: 8_000,
  cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
};

const usage = { input: 50, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 70, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

export type Turn =
  | { readonly kind: "text"; readonly deltas: readonly string[] }
  | { readonly kind: "bash"; readonly command: string };

/**
 * A real pi AgentSession behind a fake provider that replays `turns` in
 * order: a text turn streams its deltas one `text_delta` at a time (yielding
 * to the event loop every few deltas, like a network stream would); a bash
 * turn asks pi's built-in bash tool to run `command`.
 */
export async function makeSupervisedSession(label: string, turns: Turn[]) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), `supervised-session-${label}-`)));
  const agentDir = join(dir, "agent");
  await mkdir(agentDir);
  const credentials = { async read() { return undefined; }, async list() { return []; }, async modify() {}, async delete() {} };
  const runtime = await ModelRuntime.create({ modelsPath: null, credentials, refreshOnCreate: false });
  runtime.registerProvider("streaming-test", {
    baseUrl: model.baseUrl,
    api: model.api,
    apiKey: "test-account-key",
    models: [{ ...model }],
    streamSimple(requestModel: typeof model) {
      const stream = createAssistantMessageEventStream();
      const turn = turns.shift() ?? { kind: "text", deltas: ["done"] };
      queueMicrotask(async () => {
        const base = { role: "assistant", api: requestModel.api, provider: requestModel.provider, model: requestModel.id, usage, timestamp: Date.now() };
        if (turn.kind === "bash") {
          const message = { ...base, content: [{ type: "toolCall", id: "bash-call-1", name: "bash", arguments: { command: turn.command } }], stopReason: "toolUse" };
          stream.push({ type: "start", partial: message });
          stream.push({ type: "done", reason: "toolUse", message });
          return;
        }
        const partial = { ...base, content: [{ type: "text", text: "" }], stopReason: "stop" };
        stream.push({ type: "start", partial });
        for (const [index, delta] of turn.deltas.entries()) {
          partial.content[0]!.text += delta;
          stream.push({ type: "text_delta", contentIndex: 0, delta, partial });
          if (index % 10 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
        }
        stream.push({ type: "done", reason: "stop", message: { ...partial, content: [{ ...partial.content[0]! }] } });
      });
      return stream;
    },
  });
  const selectedModel = runtime.getModel("streaming-test", model.id);
  assert.ok(selectedModel);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 },
  });
  const loader = createCompatResourceLoader({ cwd: dir, agentDir, settingsManager, noExtensions: true, noSkills: true });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: dir, agentDir, modelRuntime: runtime, model: selectedModel, thinkingLevel: "off", settingsManager,
    sessionManager: SessionManager.create(dir, join(dir, "sessions")), resourceLoader: loader,
    tools: ["bash"],
  });
  await session.bindExtensions({});

  const catalog = new JsonCatalogStore({ catalogFilePath: join(dir, "catalogs.json") });
  let catalogUpserts = 0;
  const upsertSession = catalog.sessions.upsertSession;
  (catalog.sessions as { upsertSession: typeof upsertSession }).upsertSession = async (entry) => {
    catalogUpserts += 1;
    return upsertSession(entry);
  };
  const supervisor = new SessionSupervisor({
    catalogStorage: catalog,
    createAgentSessionRuntimeImpl: async () =>
      ({ session, setRebindSession() {}, dispose: async () => session.dispose() }) as never,
  });
  const workspace = await supervisor.registerWorkspace(dir, label);
  const snapshot = await supervisor.createSession(workspace, { title: label });
  const events: { type: string; text?: string; snapshot?: { status: string } }[] = [];
  supervisor.subscribe(snapshot.ref, (event) => { events.push(event as (typeof events)[number]); });
  return {
    dir,
    supervisor,
    catalog,
    ref: snapshot.ref,
    events,
    upserts: () => catalogUpserts,
    cleanup: async () => {
      session.dispose();
      // The session may still be flushing its JSONL right after dispose.
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

export async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitUntil: condition never became true");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
