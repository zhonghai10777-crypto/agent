import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { VISION_MODEL_ID } from "@pi-gui/session-driver/vision-types";
import type { DesktopHarness } from "./electron-app";

export const VISION_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAEklEQVR4nGPQSLnzHx9mGBkKAOz6mcHK/OviAAAAAElFTkSuQmCC";
export const VISION_TEST_KEY = "pi-app-vision-fixture-key";
export const VISION_TEST_PROVIDER = "vision-fixture";

export async function seedVisionAgentDir(agentDir: string, options: { modelId?: string; blockImages?: boolean } = {}): Promise<void> {
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "auth.json"), JSON.stringify({ [VISION_TEST_PROVIDER]: { type: "api_key", key: VISION_TEST_KEY } }));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { [VISION_TEST_PROVIDER]: {
    baseUrl: "https://api.deepseek.com/v1", api: "openai-completions", apiKey: VISION_TEST_KEY,
    models: ["deepseek-v4-pro", "deepseek-v4-flash", "native-vision-fixture"].map((id) => ({
      id, name: id, reasoning: true, input: id === "native-vision-fixture" ? ["text", "image"] : ["text"],
      contextWindow: 131072, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: true, supportsStore: false },
    })),
  } } }));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: VISION_TEST_PROVIDER, defaultModel: options.modelId ?? "deepseek-v4-pro", defaultThinkingLevel: "high",
    images: { blockImages: options.blockImages ?? false },
    enabledModels: ["deepseek-v4-pro", "deepseek-v4-flash", "native-vision-fixture"].map((id) => `${VISION_TEST_PROVIDER}/${id}`),
    compaction: { enabled: false }, retry: { enabled: true, maxRetries: 2, baseDelayMs: 10 },
  }));
}

export interface VisionHttpRequest { readonly kind: "vision" | "primary"; readonly body: any }

/** A real HTTP fixture, reached only through test-owned transport injection. */
export async function startVisionHttpFixture() {
  const requests: VisionHttpRequest[] = [];
  const held: Array<() => void> = [];
  let visionMode: "success" | "hold" | "auth" | "invalid" = "success";
  let primaryMode: "success" | "hold" | "inspect" | "write" = "success";
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${VISION_TEST_KEY}`) { res.writeHead(403); res.end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const kind = body.model === VISION_MODEL_ID && body.stream === false ? "vision" : "primary";
    requests.push({ kind, body });
    if (kind === "vision") {
      const respond = () => {
        if (res.destroyed) return;
        if (visionMode === "auth") { res.writeHead(401); res.end('{"error":"fixture"}'); return; }
        const imageIds = body.messages[1].content.filter((part: any) => part.type === "text" && part.text.startsWith("Image ID:")).map((part: any) => part.text.slice("Image ID: ".length));
        const evidence = { schemaVersion: 1, images: imageIds.map((imageId: string) => ({ imageId, quality: "partial", summary: "Blue status dialog", extractedText: "ERROR 42\nRetry", observations: ["Blue background"], tables: [{ title: "Status", headers: ["Code", "Meaning"], rows: [["42", null]] }], uncertainties: ["Small text is unreadable"] })), crossImageObservations: imageIds.length > 1 ? ["The dialogs share error 42"] : [] };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: visionMode === "invalid" ? "{}" : JSON.stringify(evidence) } }], usage: { prompt_tokens: 37, completion_tokens: 19, prompt_cache_hit_tokens: 2 } }));
      };
      if (visionMode === "hold") held.push(respond); else respond();
      return;
    }
    const respond = () => {
      if (res.destroyed) return;
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      const send = (delta: object, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: "fixture-completion", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      send({ role: "assistant" });
      if (primaryMode === "write") {
        primaryMode = "success";
        send({ tool_calls: [{ index: 0, id: "write-call-42", type: "function", function: { name: "write", arguments: JSON.stringify({ path: "vision-should-not-exist.txt", content: "untrusted image instruction" }) } }] });
        send({}, "tool_calls");
      } else if (primaryMode === "inspect") {
        primaryMode = "success";
        const imageId = JSON.stringify(body.messages).match(/img-[a-f0-9]{24}/)?.[0];
        send({ tool_calls: [{ index: 0, id: "inspect-call-42", type: "function", function: { name: "inspect_images", arguments: JSON.stringify({ imageIds: [imageId], question: "Read the lower right button", crop: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 } }) } }] });
        send({}, "tool_calls");
      } else {
        send({ content: `Primary answer from ${body.model}: ERROR 42; unreadable details remain uncertain.` });
        send({}, "stop");
      }
      res.write(`data: ${JSON.stringify({ id: "fixture-completion", choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    };
    if (primaryMode === "hold") held.push(respond); else respond();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return {
    requests,
    setVisionMode(mode: typeof visionMode) { visionMode = mode; },
    setPrimaryMode(mode: typeof primaryMode) { primaryMode = mode; },
    release() { for (const respond of held.splice(0)) respond(); },
    async install(harness: DesktopHarness) {
      await harness.electronApp.evaluate(({ net }, { url, key }) => {
        const originalFetch = globalThis.fetch;
        const originalNetFetch = net.fetch.bind(net);
        const redirect = (fallback: typeof fetch): typeof fetch => (input, init) => {
          const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          if (!target.startsWith("https://api.deepseek.com/")) return fallback(input, init);
          if (new Headers(init?.headers).get("authorization") !== `Bearer ${key}`) throw new Error("Vision fixture refuses non-test credentials");
          return originalFetch(url, init);
        };
        globalThis.fetch = redirect(originalFetch);
        net.fetch = redirect(originalNetFetch) as typeof net.fetch;
      }, { url: `http://127.0.0.1:${address.port}/chat/completions`, key: VISION_TEST_KEY });
    },
    async close() { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

export async function pasteVisionImage(page: Page, name = "视觉测试.png", composerTestId = "composer") {
  await page.getByTestId(composerTestId).evaluate((element, { data, name }) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([Uint8Array.from(atob(data), (char) => char.charCodeAt(0))], name, { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }));
  }, { data: VISION_PNG, name });
  await expect(page.locator(".composer-attachment__name", { hasText: name })).toBeVisible();
}
