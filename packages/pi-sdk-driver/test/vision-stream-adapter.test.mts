import test from "node:test";
import assert from "node:assert/strict";
import { createAssistantMessageEventStream, isRetryableAssistantError } from "@earendil-works/pi-ai";
import { installVisionStreamAdapter } from "../dist/pi-compat/vision-stream-adapter.js";
import { fixture, model, assistant, png } from "./vision-fixtures.mts";

test("adapter delegates to the original SDK function, preserving options and complete stream events", async () => {
  const f = fixture();
  let primary = 0;
  let payloadHook = 0;
  const original = (_model, context, options) => {
    primary++;
    assert.equal(f.calls.length, 1);
    assert.equal(_model, model);
    assert.equal(options.reasoning, "high");
    assert.equal(options.headers["x-custom"], "keep");
    assert.ok(!JSON.stringify(context).includes(png));
    const stream = createAssistantMessageEventStream();
    void options.onPayload({ messages: context.messages }, model).then(() => {
      const message = assistant();
      stream.push({ type: "start", partial: message });
      stream.push({ type: "text_delta", contentIndex: 0, delta: "Primary answer", partial: message });
      stream.push({ type: "done", reason: "stop", message });
    });
    return stream;
  };
  const session = { agent: { streamFunction: original } };
  const dispose = installVisionStreamAdapter(session, f.router, f.binding);
  const stream = await session.agent.streamFunction(model, { messages: [f.user()] }, { reasoning: "high", headers: { "x-custom": "keep" }, onPayload: async (payload) => { payloadHook++; return payload; } });
  const events = [];
  for await (const event of stream) events.push(event.type);
  assert.deepEqual(events, ["start", "text_delta", "done"]);
  assert.equal((await stream.result()).content[0].text, "Primary answer");
  assert.equal(primary, 1);
  assert.equal(payloadHook, 1);
  dispose();
  assert.equal(session.agent.streamFunction, original);
});

test("vision failures become non-retryable terminal SDK errors without calling the primary model", async () => {
  const f = fixture({ transport: async () => new Response("private", { status: 401 }) });
  let primary = 0;
  const session = { agent: { streamFunction: () => { primary++; throw new Error("must not run"); } } };
  installVisionStreamAdapter(session, f.router, f.binding);
  const stream = await session.agent.streamFunction(model, { messages: [f.user()] });
  const events = [];
  for await (const event of stream) events.push(event.type);
  const result = await stream.result();
  assert.deepEqual(events, ["error"]);
  assert.equal(result.stopReason, "error");
  assert.equal(isRetryableAssistantError(result), false);
  assert.equal(primary, 0);
});

test("Stop after vision persistence cannot start the primary request and ends the stream", async () => {
  const f = fixture();
  const controller = new AbortController();
  f.binding.onProgress = async (progress) => { if (progress.stage === "answering") controller.abort(); };
  let primary = 0;
  const session = { agent: { streamFunction: () => { primary++; throw new Error("must not run"); } } };
  installVisionStreamAdapter(session, f.router, f.binding);
  const stream = await session.agent.streamFunction(model, { messages: [f.user()] }, { signal: controller.signal });
  for await (const _ of stream) { /* consume to terminal */ }
  assert.equal((await stream.result()).stopReason, "aborted");
  assert.equal(primary, 0);
});

test("reinstallation unwraps once; native vision streams retain identity", () => {
  const f = fixture();
  const expected = createAssistantMessageEventStream();
  let calls = 0;
  const original = () => { calls++; return expected; };
  const session = { agent: { streamFunction: original } };
  installVisionStreamAdapter(session, f.router, f.binding);
  const dispose = installVisionStreamAdapter(session, f.router, f.binding);
  assert.equal(session.agent.streamFunction({ ...model, input: ["text", "image"] }, { messages: [] }), expected);
  assert.equal(calls, 1);
  dispose();
  assert.equal(session.agent.streamFunction, original);
});

test("original model error and mid-stream cancellation both terminate the wrapped SDK stream", async () => {
  for (const cancel of [false, true]) {
    const f = fixture();
    const controller = new AbortController();
    const message = { ...assistant(), stopReason: "error", errorMessage: "Primary provider rejected this request" };
    const session = { agent: { streamFunction: () => {
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: message });
      if (!cancel) stream.push({ type: "error", reason: "error", error: message });
      return stream;
    } } };
    const dispose = installVisionStreamAdapter(session, f.router, f.binding);
    const stream = await session.agent.streamFunction(model, { messages: [{ role: "user", content: "Only text", timestamp: 1 }] }, { signal: controller.signal });
    const events = [];
    for await (const event of stream) { events.push(event.type); if (cancel && event.type === "start") controller.abort(); }
    assert.deepEqual(events, ["start", "error"]);
    const result = await stream.result();
    assert.equal(result.stopReason, cancel ? "aborted" : "error");
    if (!cancel) assert.equal(result.errorMessage, message.errorMessage);
    assert.equal(f.calls.length, 0);
    dispose();
  }
});

test("final onPayload transforms cannot reintroduce images before HTTP serialization", async () => {
  const f = fixture();
  let httpRequests = 0;
  const session = { agent: { streamFunction: async (_model, context, options) => {
    await options.onPayload({ messages: context.messages }, model);
    httpRequests++;
    return createAssistantMessageEventStream();
  } } };
  const dispose = installVisionStreamAdapter(session, f.router, f.binding);
  const stream = await session.agent.streamFunction(model, { messages: [f.user()] }, { onPayload: (payload) => ({ ...payload, input: [], messages: [{ role: "user", content: [{ type: "input_image", file_id: "opaque-image" }] }] }) });
  for await (const _ of stream) { /* consume to terminal */ }
  assert.equal((await stream.result()).stopReason, "error");
  assert.equal(httpRequests, 0);
  dispose();
});
