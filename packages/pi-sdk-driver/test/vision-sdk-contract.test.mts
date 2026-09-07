import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime, SessionManager, SettingsManager, createAgentSession } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createCompatResourceLoader } from "../dist/pi-compat/resource-loader-adapter.js";
import { createCompatSession } from "../dist/pi-compat/session-adapter.js";
import { SessionSupervisor } from "../dist/session-supervisor.js";
import { createVisionSummaryExtension, installVisionStreamAdapter } from "../dist/pi-compat/vision-stream-adapter.js";
import { continueAcceptedVisionTurn, resolveVisionSessionKey, visionSessionEntries } from "../dist/pi-compat/vision-session-adapter.js";
import { fixture, model, assistant, png, response } from "./vision-fixtures.mts";

async function sdkFixture(options = {}) {
  const f = fixture(options);
  const dir = await mkdtemp(join(tmpdir(), "vision-sdk-"));
  const agentDir = join(dir, "agent");
  await mkdir(agentDir);
  const credentials = { async read() { return undefined; }, async list() { return []; }, async modify() {}, async delete() {} };
  const runtime = await ModelRuntime.create({ modelsPath: null, credentials, refreshOnCreate: false });
  const primary = [];
  let pendingPrimary;
  let nextUsage = 100;
  const emit = (stream, text) => {
    const message = assistant(text);
    message.usage.input = nextUsage;
    message.usage.totalTokens = nextUsage + 4;
    stream.push({ type: "start", partial: message });
    stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
    stream.push({ type: "done", reason: "stop", message });
  };
  runtime.registerProvider("deepseek", {
    baseUrl: model.baseUrl, api: model.api, apiKey: "test-account-key", models: [{ ...model }],
    streamSimple(requestModel, context, options) {
      const stream = createAssistantMessageEventStream();
      primary.push({ model: requestModel, context: JSON.parse(JSON.stringify(context)), options });
      if (pendingPrimary) { pendingPrimary(stream); pendingPrimary = undefined; }
      else emit(stream, /Image evidence|错误 42/.test(JSON.stringify(context)) ? "Known image fact: 错误 42. Source IDs retained." : "Primary answer");
      return stream;
    },
  });
  const selectedModel = runtime.getModel("deepseek", model.id);
  assert.ok(selectedModel);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false, reserveTokens: 128, keepRecentTokens: 32 }, retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } });
  let target;
  const loader = createCompatResourceLoader({ cwd: dir, agentDir, settingsManager, noExtensions: true, noSkills: true, extensionFactories: [createVisionSummaryExtension(f.router, () => target)] });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: dir, agentDir, modelRuntime: runtime, model: selectedModel, thinkingLevel: "high", settingsManager, sessionManager: SessionManager.create(dir, join(dir, "sessions")), resourceLoader: loader, tools: options.customTools?.map((tool) => tool.name) ?? [], customTools: options.customTools });
  await session.bindExtensions({});
  const binding = { ...f.binding, getEntries: () => visionSessionEntries(session), imagesAllowed: () => !settingsManager.getBlockImages(), resolveApiKey: (m) => resolveVisionSessionKey(session, m) };
  target = { session, binding };
  const disposeAdapter = installVisionStreamAdapter(session, f.router, binding);
  return { ...f, session, binding, primary, settingsManager, selectedModel, dir, agentDir, runtime, disposeAdapter,
    holdNextPrimary() { let release; pendingPrimary = (stream) => { release = () => emit(stream, "Released primary answer"); }; return () => release?.(); },
    replyNextWith(message) { pendingPrimary = (stream) => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: message.stopReason, message }); }; },
    setUsage(value) { nextUsage = value; },
    async close() { disposeAdapter(); await session.abort(); session.dispose(); },
  };
}

test("real Pi AgentSession retries accepted vision input without appending a second user message", async () => {
  let rejected = true;
  const f = await sdkFixture({ transport: async (_url, init) => rejected ? new Response("", { status: 401 }) : response(JSON.parse(init.body).messages[1].content.filter((part) => part.text?.startsWith("Image ID: ")).map((part) => part.text.slice(10))) });
  try {
    f.router.beginTurn(f.binding.ref, "client-id", model.id);
    await f.session.prompt("Read the dialog", { images: [{ type: "image", mimeType: "image/png", data: png }] });
    assert.equal(f.session.isIdle, true);
    assert.equal(f.calls.length, 1, "SDK must not automatically retry the local image error");
    assert.equal(f.primary.length, 0);
    const before = visionSessionEntries(f.session).filter((entry) => entry.message.role === "user");
    assert.equal(before.length, 1);
    rejected = false;
    f.router.beginTurn(f.binding.ref, "client-id", model.id);
    await continueAcceptedVisionTurn(f.session);
    assert.equal(f.session.isIdle, true);
    assert.equal(f.session.isStreaming, false);
    assert.equal(f.primary.length, 1);
    const after = visionSessionEntries(f.session).filter((entry) => entry.message.role === "user");
    assert.deepEqual(after, before);
    assert.equal(f.session.model.id, model.id);
    assert.equal(f.session.thinkingLevel, "high");
    assert.equal(f.primary[0].options.reasoning, "high");
  } finally { await f.close(); }
});

async function supervisedFixture() {
  const f = await sdkFixture();
  f.disposeAdapter();
  const supervisor = new SessionSupervisor({
    catalogFilePath: join(f.dir, "catalog.json"), visionServices: f.router.services,
    createAgentSessionRuntimeImpl: async () => ({ session: f.session, setRebindSession() {}, dispose: async () => f.session.dispose() }),
  });
  const workspace = await supervisor.registerWorkspace(f.dir, "Queue race fixture");
  const snapshot = await supervisor.createSession(workspace, { title: "Queue race" });
  return { ...f, supervisor, ref: snapshot.ref };
}

function pauseNextVisionWrite(store) {
  const write = store.update.bind(store);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let entered;
  const pending = new Promise((resolve) => { entered = resolve; });
  store.update = async (...args) => {
    store.update = write;
    entered();
    await gate;
    return write(...args);
  };
  return { pending, release: () => release() };
}

test("supervisor starts queued input when the previous run ends during persistence, preserving IDs and order", async () => {
  const f = await supervisedFixture();
  try {
    const releasePrimary = f.holdNextPrimary();
    const first = await f.supervisor.startUserMessage(f.ref, { text: "Start", clientMessageId: "first" });
    while (!f.primary.length) await new Promise((resolve) => setTimeout(resolve, 1));
    const pause = pauseNextVisionWrite(f.store);
    const timestamp = new Date().toISOString();
    const messages = [
      { id: "queued-image", text: "Read this queued image", mode: "followUp", createdAt: timestamp, updatedAt: timestamp, attachments: [{ kind: "image", mimeType: "image/png", data: png }] },
      { id: "queued-text", text: "Then explain the error", mode: "followUp", createdAt: timestamp, updatedAt: timestamp },
    ];
    const queued = f.supervisor.replaceQueuedMessages(f.ref, messages);
    await pause.pending;
    releasePrimary();
    await first.completion;
    assert.equal(f.session.isIdle, true);
    pause.release();
    await queued;
    await f.session.waitForIdle();
    assert.equal(f.primary.length, 3);
    assert.equal(f.calls.length, 1);
    const users = visionSessionEntries(f.session).filter((entry) => entry.message.role === "user");
    assert.deepEqual(users.map((entry) => entry.message.content[0].text), ["Start", "Read this queued image", "Then explain the error"]);
    await f.supervisor.replaceQueuedMessages(f.ref, messages);
    assert.equal(f.primary.length, 3, "already accepted queue entries are not replayed");
    const saved = await f.store.read(f.ref);
    assert.ok(saved.submissions.filter((entry) => entry.clientMessageId.startsWith("queued-")).every((entry) => entry.sourceMessageEntryId));
  } finally { await f.close(); }
});

test("Stop during queue persistence cannot start a new turn after cancellation settles", async () => {
  const f = await supervisedFixture();
  try {
    const pause = pauseNextVisionWrite(f.store);
    const timestamp = new Date().toISOString();
    const queued = f.supervisor.replaceQueuedMessages(f.ref, [{ id: "cancelled-queue", text: "Must not run", mode: "followUp", createdAt: timestamp, updatedAt: timestamp }]);
    const rejected = assert.rejects(queued, /cancelled/);
    await pause.pending;
    await f.supervisor.cancelCurrentRun(f.ref);
    pause.release();
    await rejected;
    assert.equal(f.primary.length, 0);
    assert.equal(f.calls.length, 0);
    assert.equal(f.session.isIdle, true);
    assert.equal(visionSessionEntries(f.session).filter((entry) => entry.message.role === "user").length, 0);
  } finally { await f.close(); }
});

test("real Pi steer and followUp consume image evidence only when dequeued and keep user order", async () => {
  const f = await sdkFixture();
  try {
    const release = f.holdNextPrimary();
    const first = f.session.prompt("Start a long answer");
    while (!f.primary.length) await new Promise((resolve) => setTimeout(resolve, 1));
    const image = { type: "image", mimeType: "image/png", data: png };
    await f.session.steer("Steer with an image", [image]);
    await f.session.followUp("Follow up with an image", [image]);
    assert.equal(f.calls.length, 0);
    release();
    await first;
    assert.equal(f.session.isIdle, true);
    assert.equal(f.calls.length, 2);
    assert.equal(f.primary.length, 3);
    assert.equal(visionSessionEntries(f.session).filter((entry) => entry.message.role === "user").length, 3);
    assert.ok(!JSON.stringify(f.primary).includes(png));
  } finally { await f.close(); }
});

test("manual compaction and branch summaries consume image evidence and preserve authorized image lookup", async () => {
  const f = await sdkFixture();
  try {
    await f.session.prompt("Read this image", { images: [{ type: "image", mimeType: "image/png", data: png }] });
    await f.session.prompt("Remember the error code and its image source");
    const calls = f.calls.length;
    const compacted = await f.session.compact();
    assert.match(compacted.summary, /错误 42/);
    assert.ok(f.primary.some((call) => JSON.stringify(call.context).includes("Image evidence")));
    assert.equal(f.calls.length, calls);
    const data = await f.store.read(f.binding.ref);
    const imageId = data.images[0].imageId;
    const inspected = await f.router.inspect(f.selectedModel, f.binding, { imageIds: [imageId], question: "Read again" });
    assert.equal(inspected.body.images[0].imageId, imageId);
    await f.session.prompt("What was in the image after compaction?");
    assert.match(JSON.stringify(f.primary.at(-1).context), /错误 42/);
    assert.ok(JSON.stringify(f.primary.at(-1).context).includes(imageId));
    const branch = f.session.sessionManager.getBranch();
    const firstAnswer = branch.find((entry) => entry.type === "message" && entry.message.role === "assistant");
    const tree = await f.session.navigateTree(firstAnswer.id, { summarize: true });
    assert.equal(tree.cancelled, false);
    assert.ok(tree.summaryEntry);
    await f.session.prompt("Continue after the branch summary");
    assert.match(JSON.stringify(f.primary.at(-1).context), /错误 42/);
    assert.ok(JSON.stringify(f.primary.at(-1).context).includes(imageId));
    assert.equal((await f.router.inspect(f.selectedModel, f.binding, { imageIds: [imageId], question: "Inspect the inherited source after tree navigation" })).body.images[0].imageId, imageId);
    assert.ok(!JSON.stringify(f.primary).includes(png));
  } finally { await f.close(); }
});

test("automatic compaction takes the same evidence projection hook", async () => {
  const f = await sdkFixture();
  try {
    f.settingsManager.setCompactionEnabled(true);
    await f.session.prompt("Read this image", { images: [{ type: "image", mimeType: "image/png", data: png }] });
    f.setUsage(model.contextWindow);
    await f.session.prompt("Now compact the long conversation");
    const compactions = f.session.sessionManager.getBranch().filter((entry) => entry.type === "compaction");
    assert.equal(compactions.length, 1);
    assert.match(compactions[0].summary, /错误 42/);
    f.settingsManager.setCompactionEnabled(false);
    await f.session.prompt("Recall the image after automatic compaction");
    assert.match(JSON.stringify(f.primary.at(-1).context), /错误 42/);
    const imageId = (await f.store.read(f.binding.ref)).images[0].imageId;
    assert.ok(JSON.stringify(f.primary.at(-1).context).includes(imageId));
    assert.equal(f.calls.length, 1);
    assert.equal(f.session.isIdle, true);
  } finally { await f.close(); }
});

test("real SDK tool screenshots are recognized in the tool loop without changing tool pairing", async () => {
  const f = await sdkFixture({ customTools: [{
    name: "screenshot", label: "Screenshot", description: "Test screenshot", parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [{ type: "image", data: png, mimeType: "image/png" }], details: {} }),
  }] });
  try {
    f.replyNextWith({ ...assistant(), stopReason: "toolUse", content: [{ type: "toolCall", id: "screenshot-call", name: "screenshot", arguments: {} }] });
    await f.session.prompt("Read the screenshot returned by the tool");
    assert.equal(f.calls.length, 1);
    assert.equal(f.primary.length, 2);
    const result = f.primary[1].context.messages.find((message) => message.role === "toolResult");
    assert.equal(result.toolCallId, "screenshot-call");
    assert.equal(result.content[0].type, "text");
    assert.match(result.content[0].text, /错误 42/);
    assert.equal(visionSessionEntries(f.session).find((entry) => entry.message.role === "toolResult").message.content[0].type, "image");
  } finally { await f.close(); }
});

test("the compatibility factory preserves Light tool exclusions while keeping readonly extension tools", async () => {
  const f = await sdkFixture();
  let runtime;
  try {
    runtime = await createCompatSession({
      cwd: f.dir, agentDir: f.agentDir, modelRuntime: f.runtime, model: f.selectedModel, settingsManager: f.settingsManager,
      sessionManager: SessionManager.create(f.dir, join(f.dir, "light-sessions")), excludeTools: ["bash", "powershell", "edit", "write"],
      resourceLoaderOptions: { noExtensions: true, noSkills: true, extensionFactories: [(pi) => pi.registerTool({ name: "inspect_images", label: "Inspect", description: "Read an authorized image", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [], details: {} }) })] },
    });
    for (const reload of [false, true]) {
      if (reload) await runtime.session.reload();
      const names = runtime.session.getActiveToolNames();
      assert.ok(names.includes("inspect_images"));
      for (const name of ["bash", "powershell", "edit", "write"]) assert.ok(!names.includes(name));
    }
  } finally { await runtime?.dispose(); await f.close(); }
});
