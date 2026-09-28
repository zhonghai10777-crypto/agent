import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime, SessionManager, SettingsManager, createAgentSession } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createCompatResourceLoader } from "../dist/pi-compat/resource-loader-adapter.js";
import { SessionSupervisor } from "../dist/session-supervisor.js";

const model = {
  id: "compaction-test-model",
  name: "Compaction Test Model",
  provider: "compaction-test",
  api: "openai-completions",
  baseUrl: "https://example.invalid",
  reasoning: false,
  input: ["text"],
  contextWindow: 200_000,
  maxTokens: 8_000,
  cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
};

function zeroUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

/**
 * A real pi AgentSession backed by a fake provider, so manual compaction
 * (`session.compact()`) runs pi's actual compaction/event-emission code -
 * this test only substitutes the HTTP layer, not pi's own logic.
 *
 * The same `streamSimple` handles both ordinary chat turns and the
 * compaction summarization call: pi routes both through
 * `this.agent.streamFunction`, and the summarization request is
 * distinguishable by its system prompt (see pi's SUMMARIZATION_SYSTEM_PROMPT).
 */
async function makeRealSession(
  label: string,
  options: { failSummarization?: boolean; turnUsage?: (turn: number) => { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number } } | undefined } = {},
) {
  // Resolved to match createCanonicalWorkspaceRef's realpath'd cwd (macOS
  // tmpdir() lives under the /var -> /private/var symlink).
  const dir = await realpath(await mkdtemp(join(tmpdir(), `compaction-events-${label}-`)));
  const agentDir = join(dir, "agent");
  await mkdir(agentDir);
  const credentials = { async read() { return undefined; }, async list() { return []; }, async modify() {}, async delete() {} };
  const runtime = await ModelRuntime.create({ modelsPath: null, credentials, refreshOnCreate: false });
  let turn = 0;
  runtime.registerProvider("compaction-test", {
    baseUrl: model.baseUrl,
    api: model.api,
    apiKey: "test-account-key",
    models: [{ ...model }],
    streamSimple(requestModel: typeof model, context: { systemPrompt?: string }) {
      const stream = createAssistantMessageEventStream();
      const isSummarization = context.systemPrompt?.includes("context summarization assistant") ?? false;
      queueMicrotask(() => {
        if (isSummarization && options.failSummarization) {
          const errorMessage = {
            role: "assistant", api: requestModel.api, provider: requestModel.provider, model: requestModel.id,
            content: [], stopReason: "error", errorMessage: "summarization boom", timestamp: Date.now(), usage: zeroUsage(),
          };
          stream.push({ type: "error", reason: "error", error: errorMessage });
          return;
        }
        turn += 1;
        const text = isSummarization ? "Summary text." : `Reply ${turn}`;
        const usage = !isSummarization ? options.turnUsage?.(turn) : undefined;
        const message = {
          role: "assistant", api: requestModel.api, provider: requestModel.provider, model: requestModel.id,
          content: [{ type: "text", text }],
          usage: usage ?? { input: 50, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 70, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop", timestamp: Date.now(),
        };
        stream.push({ type: "start", partial: message });
        stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
        stream.push({ type: "done", reason: "stop", message });
      });
      return stream;
    },
  });
  const selectedModel = runtime.getModel("compaction-test", model.id);
  assert.ok(selectedModel);
  // Small reserve/keepRecentTokens so two exchanges leave the first one to
  // summarize; retry disabled so an induced summarization failure surfaces
  // immediately instead of retrying.
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true, reserveTokens: 16, keepRecentTokens: 8 },
    retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 },
  });
  const loader = createCompatResourceLoader({ cwd: dir, agentDir, settingsManager, noExtensions: true, noSkills: true });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: dir, agentDir, modelRuntime: runtime, model: selectedModel, thinkingLevel: "off", settingsManager,
    sessionManager: SessionManager.create(dir, join(dir, "sessions")), resourceLoader: loader, tools: [],
  });
  await session.bindExtensions({});
  await session.prompt("First exchange");
  await session.prompt("Second exchange");
  return { dir, session, close: async () => { await session.abort(); session.dispose(); } };
}

async function makeSupervised(sessions: { label: string; dir: string; session: unknown }[]) {
  const byDir = new Map(sessions.map((s) => [s.dir, s.session]));
  const supervisor = new SessionSupervisor({
    createAgentSessionRuntimeImpl: async (createOptions?: { cwd?: string }) => {
      const session = byDir.get(createOptions?.cwd ?? "");
      assert.ok(session, `no fixture session registered for cwd ${createOptions?.cwd}`);
      return { session, setRebindSession() {}, dispose: async () => (session as { dispose(): void }).dispose() };
    },
  });
  const refs: Record<string, unknown> = {};
  for (const { label, dir } of sessions) {
    const workspace = await supervisor.registerWorkspace(dir, label);
    const snapshot = await supervisor.createSession(workspace, { title: label });
    refs[label] = snapshot.ref;
  }
  return { supervisor, refs };
}

function collectEvents(supervisor: { subscribe: (ref: unknown, listener: (event: { type: string }) => void) => () => void }, ref: unknown): { type: string }[] {
  const events: { type: string }[] = [];
  supervisor.subscribe(ref, (event) => { events.push(event); });
  return events;
}

/**
 * Driver events are delivered through a per-record queue (persistSnapshot +
 * per-listener emit) that `compactSession()` does not itself await past
 * `session.compact()` returning — the compaction_start/compaction_end
 * AgentSessionEvents fire synchronously inside pi's compact(), but their
 * mapped driver events reach `subscribe()` listeners asynchronously, on their
 * own schedule. Poll instead of asserting immediately after the awaited call.
 */
async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitUntil: condition never became true");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function compactionTypes(events: { type: string }[]): string[] {
  return events.filter((e) => e.type === "compactionStarted" || e.type === "compactionFinished").map((e) => e.type);
}

test("S2.1/manual: compactionStarted and compactionFinished are emitted, in order, with reason 'manual'", async () => {
  const a = await makeRealSession("a");
  try {
    const { supervisor, refs } = await makeSupervised([{ label: "a", dir: a.dir, session: a.session }]);
    const events = collectEvents(supervisor, refs.a);

    await supervisor.compactSession(refs.a);
    await waitUntil(() => compactionTypes(events).length >= 2);

    const compactionEvents = events.filter((e) => e.type === "compactionStarted" || e.type === "compactionFinished");
    assert.deepEqual(compactionEvents.map((e) => e.type), ["compactionStarted", "compactionFinished"]);
    assert.equal((compactionEvents[0] as { reason: string }).reason, "manual");
    const finished = compactionEvents[1] as { reason: string; aborted: boolean; willRetry: boolean; errorMessage?: string };
    assert.equal(finished.reason, "manual");
    assert.equal(finished.aborted, false);
    assert.equal(finished.willRetry, false);
    assert.equal(finished.errorMessage, undefined);
  } finally {
    await a.close();
  }
});

test("S2.2: a failed compaction reports compactionFinished with the failure reason, not silently", async () => {
  const a = await makeRealSession("a-fail", { failSummarization: true });
  try {
    const { supervisor, refs } = await makeSupervised([{ label: "a", dir: a.dir, session: a.session }]);
    const events = collectEvents(supervisor, refs.a);

    await assert.rejects(() => supervisor.compactSession(refs.a));
    await waitUntil(() => compactionTypes(events).length >= 2);

    const compactionEvents = events.filter((e) => e.type === "compactionStarted" || e.type === "compactionFinished");
    assert.deepEqual(compactionEvents.map((e) => e.type), ["compactionStarted", "compactionFinished"]);
    const finished = compactionEvents[1] as { errorMessage?: string; aborted: boolean };
    assert.equal(finished.aborted, false);
    assert.match(finished.errorMessage ?? "", /summarization boom/);
  } finally {
    await a.close();
  }
});

test("S2.4: compacting one session emits no compaction events on another session's listener", async () => {
  const a = await makeRealSession("iso-a");
  const b = await makeRealSession("iso-b");
  try {
    const { supervisor, refs } = await makeSupervised([
      { label: "a", dir: a.dir, session: a.session },
      { label: "b", dir: b.dir, session: b.session },
    ]);
    const eventsA = collectEvents(supervisor, refs.a);
    const eventsB = collectEvents(supervisor, refs.b);

    await supervisor.compactSession(refs.a);
    await waitUntil(() => compactionTypes(eventsA).length >= 2);

    assert.deepEqual(compactionTypes(eventsA), ["compactionStarted", "compactionFinished"], "session A sees its own compaction");
    assert.deepEqual(compactionTypes(eventsB), [], "session B must not see session A's compaction events");

    // And the reverse: compacting B now must not replay anything into A's listener.
    await supervisor.compactSession(refs.b);
    await waitUntil(() => compactionTypes(eventsB).length >= 2);

    assert.deepEqual(compactionTypes(eventsA), ["compactionStarted", "compactionFinished"], "A's own earlier compaction, unchanged");
    assert.deepEqual(compactionTypes(eventsB), ["compactionStarted", "compactionFinished"]);
  } finally {
    await a.close();
    await b.close();
  }
});

test("automatic threshold compaction reopens 'running' while it runs and settles to idle without a duplicate runCompleted", async () => {
  // 199,990 sits strictly between the compaction threshold (contextWindow 200,000
  // minus reserveTokens 16 = 199,984) and the full context window (200,000):
  // enough to trigger threshold compaction, not so much it reads as overflow.
  const a = await makeRealSession("auto", {
    turnUsage: (turn) => (turn === 3 ? { input: 199_970, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 199_990, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } : undefined),
  });
  try {
    const { supervisor, refs } = await makeSupervised([{ label: "a", dir: a.dir, session: a.session }]);
    const events = collectEvents(supervisor, refs.a);

    await a.session.prompt("Trigger threshold compaction");
    await waitUntil(() => compactionTypes(events).length >= 2, 5000);

    const compactionEvents = events.filter((e) => e.type === "compactionStarted" || e.type === "compactionFinished");
    assert.equal((compactionEvents[0] as { reason: string }).reason, "threshold");
    assert.equal((compactionEvents[1] as { reason: string }).reason, "threshold");

    // Exactly one runCompleted for the actual reply. Reopening "running" for
    // compaction and settling back to idle afterward must not add a second
    // one (that would risk a duplicate "Agent finished responding" notification).
    assert.equal(events.filter((e) => e.type === "runCompleted").length, 1);

    // Between compactionStarted and compactionFinished, at least one
    // sessionUpdated shows the session as "running" - so the composer
    // queues a message sent in that window instead of rejecting it.
    const startedAt = events.indexOf(compactionEvents[0]);
    const finishedAt = events.indexOf(compactionEvents[1]);
    assert.ok(startedAt >= 0 && finishedAt > startedAt);
    const duringCompaction = events.slice(startedAt, finishedAt) as { type: string; snapshot?: { status: string } }[];
    assert.ok(
      duringCompaction.some((e) => e.type === "sessionUpdated" && e.snapshot?.status === "running"),
      "session must read as running while auto-compaction is in progress",
    );

    // And it settles back to idle as soon as compaction finishes.
    await waitUntil(() => {
      const afterFinished = events.slice(finishedAt) as { type: string; snapshot?: { status: string } }[];
      return afterFinished.some((e) => e.type === "sessionUpdated" && e.snapshot?.status === "idle");
    }, 5000);
  } finally {
    await a.close();
  }
});

test("a failed automatic compaction also settles back to idle without a duplicate runCompleted", async () => {
  const a = await makeRealSession("auto-fail", {
    failSummarization: true,
    turnUsage: (turn) => (turn === 3 ? { input: 199_970, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 199_990, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } : undefined),
  });
  try {
    const { supervisor, refs } = await makeSupervised([{ label: "a", dir: a.dir, session: a.session }]);
    const events = collectEvents(supervisor, refs.a);

    await a.session.prompt("Trigger threshold compaction");
    await waitUntil(() => compactionTypes(events).length >= 2, 5000);

    const compactionEvents = events.filter((e) => e.type === "compactionStarted" || e.type === "compactionFinished");
    const finished = compactionEvents[1] as { reason: string; aborted: boolean; errorMessage?: string };
    assert.equal(finished.reason, "threshold");
    assert.match(finished.errorMessage ?? "", /summarization boom/);

    assert.equal(events.filter((e) => e.type === "runCompleted").length, 1, "the failed compaction itself must not be reported as a run completion");

    const finishedAt = events.indexOf(compactionEvents[1]);
    await waitUntil(() => {
      const afterFinished = events.slice(finishedAt) as { type: string; snapshot?: { status: string } }[];
      return afterFinished.some((e) => e.type === "sessionUpdated" && e.snapshot?.status === "idle");
    }, 5000);
  } finally {
    await a.close();
  }
});
