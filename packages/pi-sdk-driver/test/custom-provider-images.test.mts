import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { CustomProviderStore } from "../dist/custom-provider-store.js";
import { defaultCustomModelInput } from "../dist/custom-provider-types.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "pi-image-capability-"));
  const path = join(directory, "models.json");
  return { directory, path, store: new CustomProviderStore(path) };
}

test("custom image and text-only capabilities survive reads, edits and reopening the store", async () => {
  const { path, store } = await fixture();
  const endpoint = { providerId: "custom-vision", baseUrl: "http://localhost:8080/v1" };
  await store.set({ ...endpoint, models: [
    { id: "vision-model", input: ["text", "image"], contextWindow: 64000 },
    { id: "text-model", input: ["text"] },
  ] });
  assert.deepEqual((await store.list())[0]?.models, [
    { id: "vision-model", contextWindow: 64000, input: ["text", "image"] },
    { id: "text-model", input: ["text"] },
  ]);
  // Older callers may omit capabilities on an unrelated endpoint edit.
  await store.set({ ...endpoint, baseUrl: "http://localhost:9090/v1", models: [{ id: "vision-model" }, { id: "text-model" }] });
  assert.deepEqual((await new CustomProviderStore(path).list())[0]?.models.map((model) => model.input), [["text", "image"], ["text"]]);
  await store.set({ ...endpoint, models: [{ id: "vision-model", input: ["text"] }] });
  assert.deepEqual((await store.list())[0]?.models[0]?.input, ["text"]);
});

test("official Flash defaults are narrow and explicit text-only choices win", async () => {
  const { store } = await fixture();
  for (const id of ["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"]) {
    assert.deepEqual(defaultCustomModelInput("https://api.deepseek.com/v1/", id), ["text", "image"]);
  }
  for (const url of ["https://api.deepseek.com.example.org/v1", "http://localhost:8080/v1", "https://api.deepseek.com/other"]) {
    assert.deepEqual(defaultCustomModelInput(url, "deepseek-flash"), ["text"]);
  }
  assert.deepEqual(defaultCustomModelInput("https://api.deepseek.com", "deepseek-v4-pro"), ["text"]);
  await store.set({ providerId: "deepseek-api", baseUrl: "https://api.deepseek.com/v1", models: [{ id: "deepseek-flash" }] });
  assert.deepEqual((await store.list())[0]?.models[0]?.input, ["text", "image"]);
  await store.set({ providerId: "deepseek-api", baseUrl: "https://api.deepseek.com/v1", models: [{ id: "deepseek-flash", input: ["text"] }] });
  assert.deepEqual((await store.list())[0]?.models[0]?.input, ["text"]);
});

test("legacy migration changes only missing official Flash capabilities and preserves original bytes in backup", async () => {
  const { path, store } = await fixture();
  const original = JSON.stringify({ unrelated: { retained: true }, providers: {
    "deepseek-api": {
      baseUrl: "https://api.deepseek.com/v1", api: "openai-completions", apiKey: "legacy-test-secret", piGuiCustomEndpoint: true,
      headers: { "x-test": "keep" }, models: [
        { id: "deepseek-flash", reasoning: true, contextWindow: 1000000 },
        { id: "deepseek-v4-flash", input: ["text"] },
        { id: "deepseek-v4-pro" },
      ],
    },
    "local-api": { baseUrl: "http://localhost:8080/v1", api: "openai-completions", models: [{ id: "deepseek-flash" }] },
  } }, null, 2);
  await writeFile(path, original);
  await store.migrateImageCapabilities();
  const migrated = JSON.parse(await readFile(path, "utf8"));
  const expected = JSON.parse(original);
  expected.providers["deepseek-api"].models[0].input = ["text", "image"];
  assert.deepEqual(migrated, expected);
  assert.equal(await readFile(`${path}.bak`, "utf8"), original);
  const firstStat = await stat(path);
  await store.migrateImageCapabilities();
  assert.equal((await stat(path)).mtimeMs, firstStat.mtimeMs, "Migration must be idempotent");
  assert.equal(await readFile(`${path}.bak`, "utf8"), original);
});

test("invalid capability input does not replace a previously valid configuration", async () => {
  const { path, store } = await fixture();
  const endpoint = { providerId: "vision-api", baseUrl: "http://localhost:8080/v1" };
  await store.set({ ...endpoint, models: [{ id: "vision", input: ["text", "image"] }] });
  const original = await readFile(path, "utf8");
  for (const invalid of [null, [], ["video"], ["text", true], "image"]) {
    await assert.rejects(store.set({ ...endpoint, models: [{ id: "vision", input: invalid as never }] }), /input must/);
    assert.equal(await readFile(path, "utf8"), original);
  }
});

test("actual pi request serialization preserves screenshots after legacy capability migration", async () => {
  const { directory, path, store } = await fixture();
  await writeFile(path, JSON.stringify({ providers: {
    "deepseek-api": { baseUrl: "https://api.deepseek.com/v1", api: "openai-completions", apiKey: "unused", piGuiCustomEndpoint: true, models: [{ id: "deepseek-flash" }] },
  } }));
  const image = { type: "image" as const, mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jmioAAAAASUVORK5CYII=" };
  const context = { messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "Inspect this screenshot" }, image], timestamp: 0 }] };
  const capture = async () => {
    const runtime = await ModelRuntime.create({ modelsPath: path, authPath: join(directory, "auth.json"), refreshOnCreate: false, allowModelNetwork: false });
    const model = runtime.getModel("deepseek-api", "deepseek-flash");
    assert.ok(model);
    let request: any;
    await runtime.complete(model, context, { apiKey: "test-no-network", onPayload(payload) {
      request = payload;
      // Capture the real request before the SDK can perform any network I/O.
      throw new Error("request captured by test");
    } });
    assert.ok(request, "Real request builder must run");
    return request.messages[0].content;
  };
  const before = await capture();
  assert.deepEqual(before.map((block: any) => block.type), ["text", "text"]);
  assert.match(before[1].text, /image omitted: model does not support images/);
  await store.migrateImageCapabilities();
  const after = await capture();
  assert.deepEqual(after.map((block: any) => block.type), ["text", "image_url"]);
  assert.equal(after[1].image_url.url, `data:${image.mimeType};base64,${image.data}`);
  assert.equal(context.messages[0]?.content[1], image);
});
