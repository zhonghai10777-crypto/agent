import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { ImageInputDisabledError, prepareSessionImageInput } from "../dist/image-input.js";
import { shouldRouteVision } from "../dist/vision-router.js";

const screenshot = [{ kind: "image" as const, mimeType: "image/png", data: "synthetic-image" }];

function fixture(input: ("text" | "image")[], latestInput: ("text" | "image")[]) {
  const original = { provider: "custom", id: "vision", input, contextWindow: 64000 };
  const agent = { state: { model: original } };
  const state = { streaming: false };
  const session = {
    agent,
    get model() { return agent.state.model; },
    get isStreaming() { return state.streaming; },
    modelRuntime: { getModel: () => ({ ...original, input: latestInput, contextWindow: 99999 }) },
  } as unknown as AgentSession;
  return { session, original, state };
}

test("saved image capability applies to the next turn without changing other model settings or sessions", () => {
  const { session, original } = fixture(["text"], ["text", "image"]);
  prepareSessionImageInput(session, screenshot);
  assert.deepEqual(session.model?.input, ["text", "image"]);
  assert.equal(session.model?.contextWindow, 64000, "An image setting must not silently change other session configuration");
  assert.deepEqual(original.input, ["text"], "A model object shared by another session must remain untouched");

  const disabled = fixture(["text", "image"], ["text"]);
  assert.throws(() => prepareSessionImageInput(disabled.session, screenshot), ImageInputDisabledError);
  assert.deepEqual(disabled.session.model?.input, ["text"]);
  assert.doesNotThrow(() => prepareSessionImageInput(disabled.session), "Text prompts still work");
});

test("queued screenshots use the active run capability until the run finishes", () => {
  const enabled = fixture(["text"], ["text", "image"]);
  enabled.state.streaming = true;
  assert.throws(() => prepareSessionImageInput(enabled.session, screenshot), ImageInputDisabledError);
  assert.equal(enabled.session.model, enabled.original);
  enabled.state.streaming = false;
  assert.doesNotThrow(() => prepareSessionImageInput(enabled.session, screenshot));

  const disabled = fixture(["text", "image"], ["text"]);
  disabled.state.streaming = true;
  assert.doesNotThrow(() => prepareSessionImageInput(disabled.session, screenshot));
  assert.equal(disabled.session.model, disabled.original);
  disabled.state.streaming = false;
  assert.throws(() => prepareSessionImageInput(disabled.session, screenshot), ImageInputDisabledError);
});

test("configured DeepSeek assistance still handles text-model images after a capability edit", () => {
  const assisted = fixture(["text", "image"], ["text"]);
  Object.assign(assisted.original, { id: "deepseek-v4-pro", baseUrl: "https://api.deepseek.com/v1" });
  assert.doesNotThrow(() => prepareSessionImageInput(assisted.session, screenshot, shouldRouteVision));
  assert.deepEqual(assisted.session.model?.input, ["text"]);

  const unknown = fixture(["text"], ["text"]);
  Object.assign(unknown.original, { baseUrl: "https://api.deepseek.com/v1" });
  assert.throws(() => prepareSessionImageInput(unknown.session, screenshot, shouldRouteVision), ImageInputDisabledError);
});
