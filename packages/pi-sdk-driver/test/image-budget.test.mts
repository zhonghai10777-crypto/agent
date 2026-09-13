import assert from "node:assert/strict";
import test from "node:test";
import { assertImageAttachments, assertImageSizes, base64ImageSize } from "@pi-gui/session-driver/image-budget";
import { fixture, model, png } from "./vision-fixtures.mts";
import { installVisionStreamAdapter } from "../dist/pi-compat/vision-stream-adapter.js";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("shared image preflight bounds count, single file, aggregate bytes and invalid encoding before decoding", () => {
  assert.throws(() => assertImageSizes(Array(9).fill(10)), /at most 8 images/);
  assert.throws(() => assertImageSizes([10 * 1024 * 1024 + 1]), /Each image/);
  assert.throws(() => assertImageSizes([8, 8, 8].map((m) => m * 1024 * 1024)), /total at most/);
  assert.throws(() => base64ImageSize("%==="), /valid Base64/);
  assert.doesNotThrow(() => assertImageAttachments([{ kind: "image", data: png }]));
});

test("native policy covers current, historical and tool images without invoking assistance", async () => {
  const f = fixture();
  f.config.enabled = false;
  const native = { ...model, input: ["text", "image"] };
  const context = { messages: [f.user(), { role: "toolResult", toolCallId: "screenshot", toolName: "read", content: [{ type: "image", data: png, mimeType: "image/png" }], timestamp: 2 }] };
  assert.equal(await f.router.project(native, context, f.binding), context);
  assert.equal(f.calls.length, 0);
  f.binding.imagesAllowed = () => false;
  await assert.rejects(f.router.project(native, context, f.binding), { code: "VISION_DISABLED" });
  f.binding.imagesAllowed = () => true;
  f.config.maxImageBytes = 10;
  await assert.rejects(f.router.project(native, context, f.binding), { code: "VISION_IMAGE_LIMIT" });
  assert.equal(f.calls.length, 0);
});

test("real SDK native serialization checks history, JSON/text overhead and final transforms before HTTP", async () => {
  const dir = await mkdtemp(join(tmpdir(), "native-image-budget-"));
  const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
  const native = { ...runtime.getModel("deepseek", "deepseek-v4-flash-vision-exp")! };
  const f = fixture();
  f.config.enabled = false;
  f.config.maxRequestBodyBytes = 700;
  const session = { agent: { streamFunction: (m, c, o) => runtime.streamSimple(m, c, o) } };
  installVisionStreamAdapter(session, f.router, f.binding);
  let captured: any;
  const stream = session.agent.streamFunction(native, { messages: [f.user("history"), f.user("current")] }, {
    apiKey: "synthetic-no-network", onPayload(payload) { captured = payload; return { ...payload, padding: "x".repeat(700) }; },
  });
  const result = await stream.result();
  assert.equal(captured.messages.filter((m) => m.role === "user").flatMap((m) => m.content).filter((part) => part.type === "image_url").length, 2);
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage, /complete request.*history/);
  assert.equal(f.calls.length, 0);
  assert.throws(() => f.router.assertPayloadBudget({ messages: [{ role: "user", content: "x".repeat(700) }] }, f.binding), { code: "VISION_PAYLOAD" });
});

test("final protocol blocks cannot bypass global policy or message count", () => {
  const f = fixture();
  const part = { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } };
  assert.throws(() => f.router.assertPayloadBudget({ messages: [{ content: Array(9).fill(part) }] }, f.binding), { code: "VISION_IMAGE_LIMIT" });
  f.binding.imagesAllowed = () => false;
  for (const payload of [{ messages: [{ content: [part] }] }, { input: [{ type: "input_image", image_url: part.image_url.url }] }, { contents: [{ parts: [{ inlineData: { data: png, mimeType: "image/png" } }] }] }]) {
    assert.throws(() => f.router.assertPayloadBudget(payload, f.binding), { code: "VISION_DISABLED" });
  }
});
