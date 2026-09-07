import { DEFAULT_VISION_ROUTING_SETTINGS } from "@pi-gui/session-driver/vision-types";
import { emptyVisionSession, VisionRouter } from "../dist/vision-router.js";

export const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOZkAAAAASUVORK5CYII=";
export const model = { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", provider: "deepseek", api: "openai-completions", baseUrl: "https://api.deepseek.com", reasoning: true, input: ["text"], contextWindow: 1_000_000, maxTokens: 16_384, cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } };
export const ref = { workspaceId: "workspace", sessionId: "session" };
export const settings = { ...DEFAULT_VISION_ROUTING_SETTINGS, attemptTimeoutMs: 2000, totalTimeoutMs: 10_000 };

export function evidence(ids: string[]) {
  return { schemaVersion: 1, images: ids.map((imageId) => ({ imageId, quality: "complete", summary: "A settings dialog", extractedText: "错误 42\nRetry", observations: ["Two buttons"], tables: [], uncertainties: [] })), crossImageObservations: ids.length > 1 ? ["The dialogs show the same error"] : [] };
}

export function response(ids: string[], options: { content?: string; finish?: string; usage?: boolean } = {}) {
  return new Response(JSON.stringify({ choices: [{ finish_reason: options.finish ?? "stop", message: { content: options.content ?? JSON.stringify(evidence(ids)) } }], ...(options.usage === false ? {} : { usage: { prompt_tokens: 37, completion_tokens: 23, prompt_cache_hit_tokens: 2 } }) }), { headers: { "Content-Type": "application/json" } });
}

export function fixture(options: { transport?: (url: unknown, init: RequestInit) => Promise<Response>; failWrite?: () => boolean } = {}) {
  const records = new Map();
  const calls: { url: unknown; body: any; init: RequestInit }[] = [];
  const progress: any[] = [];
  const entries: any[] = [];
  const key = (reference: any) => JSON.stringify(reference);
  const store = {
    async read(reference: any) { const value = records.get(key(reference)); return value && structuredClone(value); },
    async update(reference: any, fn: any) {
      if (options.failWrite?.()) throw Object.assign(new Error("cannot write"), { code: "EACCES" });
      const next = fn(structuredClone(records.get(key(reference)) ?? emptyVisionSession("profile", reference)));
      records.set(key(reference), structuredClone(next));
      return next;
    },
    async remove(reference: any) { records.delete(key(reference)); },
  };
  const config = { ...settings };
  const router = new VisionRouter({
    profileScopeId: "profile", store, getSettings: () => config,
    fetch: async (url: unknown, init: any) => {
      const body = JSON.parse(init.body);
      calls.push({ url, body, init });
      if (options.transport) return options.transport(url, init);
      const ids = body.messages[1].content.filter((block: any) => block.type === "text" && block.text.startsWith("Image ID: ")).map((block: any) => block.text.slice(10));
      return response(ids);
    },
    prepareImage: async (image: any) => ({ ...image, bytes: Buffer.from(image.data, "base64").length, width: 1, height: 1 }),
  });
  const binding = {
    ref, getEntries: () => entries, imagesAllowed: () => true,
    resolveApiKey: async () => "test-account-key", onProgress: async (value: any) => { progress.push(value); },
  };
  const user = (id = "entry-1", text = "What does this say?", count = 1) => {
    const message = { role: "user", content: [...(text ? [{ type: "text", text }] : []), ...Array.from({ length: count }, () => ({ type: "image", data: png, mimeType: "image/png" }))], timestamp: entries.length + 1 };
    entries.push({ id, message });
    return message;
  };
  return { router, store, records, calls, progress, entries, binding, user, config };
}

export function assistant(text = "Primary answer") {
  return { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [{ type: "text", text }], usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 14, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
}
