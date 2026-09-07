import test from "node:test";
import assert from "node:assert/strict";
import { assertTextOnlyPayload, officialDeepSeekEndpoint, VisionEvidenceCache } from "../dist/vision-router.js";
import { fixture, model, ref, png } from "./vision-fixtures.mts";

test("multi-image evidence precedes the original model context and keeps original history intact", async () => {
  const f = fixture();
  const user = f.user("entry", "Compare these", 2);
  const context = { systemPrompt: "Original system", messages: [user], tools: [{ name: "read", parameters: {} }] };
  const before = structuredClone(context);
  const projected = await f.router.project(model, context, f.binding);
  assert.deepEqual(context, before);
  assert.equal(projected.systemPrompt, context.systemPrompt);
  assert.equal(projected.tools, context.tools);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].body.messages[1].content.filter((part) => part.type === "image_url").length, 2);
  assertTextOnlyPayload(projected);
  assert.ok(JSON.stringify(projected).includes("dialogs show the same error"));
  const stored = await f.store.read(ref);
  assert.equal(stored.images.length, 2);
  assert.equal(new Set(stored.images.map((image) => image.imageId)).size, 2);
  assert.equal(stored.evidence.length, 1);
  assert.ok(f.progress.some((progress) => progress.stage === "persisting"));
});

test("historical evidence stays bound to the first question across tool loops and restarts", async () => {
  const f = fixture();
  const user = f.user();
  await f.router.project(model, { messages: [user] }, f.binding);
  const continuation = { role: "user", content: "Explain the error", timestamp: 55 };
  f.entries.push({ id: "later", message: continuation });
  await f.router.project(model, { messages: [user, continuation] }, f.binding);
  assert.equal(f.calls.length, 1);
  assert.equal((await f.store.read(ref)).images[0].question, "What does this say?");
  assert.equal((await f.store.read(ref)).evidence[0].usage.inputTokens, 37);
});

test("text-only and native image models do not call the vision transport", async () => {
  const f = fixture();
  await f.router.project(model, { messages: [{ role: "user", content: "Hello", timestamp: 1 }] }, f.binding);
  const context = { messages: [f.user()] };
  assert.equal(await f.router.project({ ...model, input: ["text", "image"] }, context, f.binding), context);
  assert.equal(f.calls.length, 0);
});

test("disabled and forged providers block images without ever borrowing a credential", async () => {
  const f = fixture();
  const context = { messages: [f.user()] };
  let auth = 0;
  f.binding.resolveApiKey = async () => { auth++; return "private"; };
  f.config.enabled = false;
  await assert.rejects(f.router.project(model, context, f.binding), { code: "VISION_DISABLED" });
  f.config.enabled = true;
  for (const baseUrl of ["http://api.deepseek.com", "https://api.deepseek.com.evil.test", "https://api.deepseek.com:8443", "https://api.deepseek.com/path", "https://user@api.deepseek.com"]) {
    assert.equal(officialDeepSeekEndpoint(baseUrl), undefined);
    await assert.rejects(f.router.project({ ...model, baseUrl }, context, f.binding), { code: "VISION_UNSUPPORTED_PROVIDER" });
  }
  assert.equal(auth, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(officialDeepSeekEndpoint("https://api.deepseek.com/anthropic/v1/"), "https://api.deepseek.com");
});

test("tool screenshots are visual user inputs but preserve the original tool result and call ID", async () => {
  const f = fixture();
  const tool = { role: "toolResult", toolName: "screenshot", toolCallId: "call-42", content: [{ type: "text", text: "Original tool text" }, { type: "image", data: png, mimeType: "image/png" }], isError: false, timestamp: 2 };
  f.entries.push({ id: "tool-entry", message: tool });
  const projected = await f.router.project(model, { messages: [tool] }, f.binding);
  assert.equal(projected.messages[0].toolCallId, "call-42");
  assert.equal(projected.messages[0].role, "toolResult");
  assert.equal(projected.messages[0].content[0].text, "Original tool text");
  assert.equal(f.calls[0].body.messages[1].role, "user");
  assert.equal(tool.content[1].type, "image");
});

test("persistence failure blocks handoff and keeps the original images", async () => {
  let fail = false;
  const f = fixture({ failWrite: () => fail });
  const user = f.user();
  f.binding.onProgress = async (progress) => { if (progress.stage === "persisting") fail = true; };
  await assert.rejects(f.router.project(model, { messages: [user] }, f.binding), { code: "VISION_STORAGE" });
  assert.equal(user.content[1].type, "image");
  assert.equal((await f.store.read(ref)).evidence.length, 0);
});

test("inspection checks current branch authorization; fork excludes later images", async () => {
  const f = fixture();
  const first = f.user("first");
  await f.router.project(model, { messages: [first] }, f.binding);
  const firstId = (await f.store.read(ref)).images[0].imageId;
  const later = f.user("later");
  f.router.beginTurn(ref, "later", model.id);
  await f.router.project(model, { messages: [first, later] }, f.binding);
  const child = { ...ref, sessionId: "child" };
  await f.router.fork(ref, child, [f.entries[0]]);
  assert.equal((await f.store.read(child)).images.length, 1);
  f.entries.splice(0, 1);
  await assert.rejects(f.router.inspect(model, f.binding, { imageIds: [firstId], question: "Read again" }), { code: "VISION_UNAUTHORIZED_IMAGE" });
  assert.equal(f.calls.length, 2);
});

test("final payload guard catches protocol image encodings but keeps business data named image", () => {
  for (const part of [{ type: "image" }, { type: "image_url", image_url: { url: "https://private/image.png" } }, { type: "input_image", file_id: "f1" }, { type: "file", file: { file_data: `data:image/png;base64,${png}` } }, { type: "text", text: `data:image/png;base64,${png}` }]) {
    assert.throws(() => assertTextOnlyPayload({ messages: [{ role: "user", content: [part] }] }), { code: "VISION_PAYLOAD" });
  }
  assert.doesNotThrow(() => assertTextOnlyPayload({ messages: [{ role: "assistant", content: [{ type: "toolCall", arguments: { image: "business field" } }] }, { role: "user", content: "What does image_url mean?" }] }));
});

test("cache stays bounded without being the owner of durable evidence", () => {
  const cache = new VisionEvidenceCache();
  for (let i = 0; i < 100; i++) cache.set(String(i), { evidenceId: String(i), body: { text: "evidence" } });
  assert.equal(cache.size, 64);
  assert.equal(cache.get("0"), undefined);
  assert.ok(cache.byteSize <= 8 * 1024 * 1024);
});
