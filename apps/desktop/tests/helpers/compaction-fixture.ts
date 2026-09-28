import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DesktopHarness } from "./electron-app";

export const COMPACTION_TEST_KEY = "pi-app-compaction-fixture-key";
export const COMPACTION_TEST_PROVIDER = "compaction-fixture";
export const COMPACTION_TEST_MODEL_ID = "compaction-fixture-v4";
export const COMPACTION_TEST_BASE_URL = "https://api.compaction-fixture.test/v1";

/**
 * Seeds an agentDir with one large-context custom model (DeepSeek v4-shaped:
 * a 1,000,000 token context window), so the driver's auto-compaction budget
 * (compaction-budget.ts, AUTO_COMPACT_TOKEN_BUDGET = 256,000) applies. Retry
 * is disabled so an induced summarization failure (test B) surfaces at once
 * instead of after a retry delay.
 */
export async function seedCompactionAgentDir(
  agentDir: string,
  options: { readonly contextWindow?: number; readonly maxTokens?: number; readonly keepRecentTokens?: number } = {},
): Promise<void> {
  await mkdir(agentDir, { recursive: true });
  // The three files are independent (no ordering requirement between them),
  // so write them concurrently rather than one after another.
  await Promise.all([
    writeFile(
      join(agentDir, "auth.json"),
      JSON.stringify({ [COMPACTION_TEST_PROVIDER]: { type: "api_key", key: COMPACTION_TEST_KEY } }),
    ),
    writeFile(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          [COMPACTION_TEST_PROVIDER]: {
            baseUrl: COMPACTION_TEST_BASE_URL,
            api: "openai-completions",
            apiKey: COMPACTION_TEST_KEY,
            models: [
              {
                id: COMPACTION_TEST_MODEL_ID,
                name: COMPACTION_TEST_MODEL_ID,
                reasoning: false,
                input: ["text"],
                contextWindow: options.contextWindow ?? 1_000_000,
                maxTokens: options.maxTokens ?? 384_000,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, supportsStore: false },
              },
            ],
          },
        },
      }),
    ),
    writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({
        defaultProvider: COMPACTION_TEST_PROVIDER,
        defaultModel: COMPACTION_TEST_MODEL_ID,
        defaultThinkingLevel: "off",
        enabledModels: [`${COMPACTION_TEST_PROVIDER}/${COMPACTION_TEST_MODEL_ID}`],
        // The token budget that decides WHETHER to compact (shouldCompact) is
        // driven entirely by the model's reported usage.totalTokens, which
        // these fixtures fake freely. But WHAT gets summarized (prepareCompaction
        // -> findCutPoint) is driven by pi's own character-count token estimate
        // of the real, tiny fixture conversation, entirely independent of that
        // faked usage. Left at its default (20,000), findCutPoint would walk
        // back through the whole (small) conversation without ever reaching the
        // threshold and keep everything, leaving nothing to summarize -
        // prepareCompaction then returns undefined and _runAutoCompaction
        // no-ops silently, without ever emitting compaction_start/end. A tiny
        // keepRecentTokens keeps only the last message and makes the rest
        // (real content) eligible to summarize.
        compaction: { enabled: true, keepRecentTokens: options.keepRecentTokens ?? 8 },
        retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 },
      }),
    ),
  ]);
}

export interface CompactionHttpRequest {
  readonly kind: "primary" | "summarization";
  readonly body: any;
}

/**
 * A real HTTP fixture reached only through test-owned transport injection
 * (mirrors vision-fixture.ts's startVisionHttpFixture). Every request is
 * streamed SSE, matching pi's real chat-completions wire format for both
 * ordinary turns and compaction's summarization call - the latter reuses
 * `agent.streamFunction`, it does not switch to a non-streaming request.
 * A summarization request is told apart by its system prompt, which pi sets
 * to SUMMARIZATION_SYSTEM_PROMPT ("You are a context summarization
 * assistant...").
 */
export async function startCompactionHttpFixture() {
  const requests: CompactionHttpRequest[] = [];
  const held: Array<() => void> = [];
  let primaryCallCount = 0;
  let nextToolCallPath: string | undefined;
  let nextUsage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } = {
    prompt_tokens: 300_000,
    completion_tokens: 40,
    total_tokens: 300_040,
  };
  let nextReplyText = "Final answer after reading the file.";
  let summarizationMode: "success" | "http500" | "hold" = "success";
  let summaryText = "Fixed compaction summary text.";

  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${COMPACTION_TEST_KEY}`) {
      res.writeHead(403);
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const isSummarization = JSON.stringify(body.messages ?? []).includes("context summarization assistant");
    requests.push({ kind: isSummarization ? "summarization" : "primary", body });

    if (isSummarization) {
      const respond = () => {
        if (res.destroyed) return;
        if (summarizationMode === "http500") {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Synthetic summarization failure" } }));
          return;
        }
        writeSseCompletion(res, body.model, { content: summaryText }, { prompt_tokens: 500, completion_tokens: 30, total_tokens: 530 });
      };
      if (summarizationMode === "hold") held.push(respond);
      else respond();
      return;
    }

    const callIndex = primaryCallCount;
    primaryCallCount += 1;
    if (callIndex === 0 && nextToolCallPath) {
      const path = nextToolCallPath;
      nextToolCallPath = undefined;
      writeSseCompletion(res, body.model, {
        tool_calls: [
          { index: 0, id: "read-document-call-1", type: "function", function: { name: "read_document", arguments: JSON.stringify({ path }) } },
        ],
      });
      return;
    }
    writeSseCompletion(res, body.model, { content: nextReplyText }, nextUsage);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };

  return {
    requests,
    /** The next turn's first response is a read_document tool call for this path (consumed once). */
    setNextToolCallPath(path: string) {
      nextToolCallPath = path;
    },
    setNextUsage(usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }) {
      nextUsage = usage;
    },
    setNextReplyText(text: string) {
      nextReplyText = text;
    },
    setSummarizationMode(mode: typeof summarizationMode) {
      summarizationMode = mode;
    },
    setSummaryText(text: string) {
      summaryText = text;
    },
    release() {
      for (const respond of held.splice(0)) respond();
    },
    async install(harness: DesktopHarness) {
      await harness.electronApp.evaluate(
        ({ net }, { url, key }) => {
          const originalFetch = globalThis.fetch;
          const originalNetFetch = net.fetch.bind(net);
          const redirect =
            (fallback: typeof fetch): typeof fetch =>
            (input, init) => {
              const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
              if (!target.startsWith("https://api.compaction-fixture.test/")) return fallback(input, init);
              if (new Headers(init?.headers).get("authorization") !== `Bearer ${key}`) {
                throw new Error("Compaction fixture refuses non-test credentials");
              }
              return originalFetch(url, init);
            };
          globalThis.fetch = redirect(originalFetch);
          net.fetch = redirect(originalNetFetch) as typeof net.fetch;
        },
        { url: `http://127.0.0.1:${address.port}/chat/completions`, key: COMPACTION_TEST_KEY },
      );
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function writeSseCompletion(
  res: import("node:http").ServerResponse,
  model: string,
  delta: { content?: string; tool_calls?: unknown[] },
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number },
): void {
  if (res.destroyed) return;
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  const send = (chunkDelta: object, finish_reason: string | null = null) =>
    res.write(
      `data: ${JSON.stringify({
        id: "compaction-fixture-completion",
        object: "chat.completion.chunk",
        created: 1,
        model,
        choices: [{ index: 0, delta: chunkDelta, finish_reason }],
      })}\n\n`,
    );
  send({ role: "assistant" });
  if (delta.tool_calls) {
    send({ tool_calls: delta.tool_calls });
    send({}, "tool_calls");
  } else {
    send({ content: delta.content ?? "" });
    send({}, "stop");
  }
  res.write(
    `data: ${JSON.stringify({
      id: "compaction-fixture-completion",
      choices: [],
      usage: usage ?? { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })}\n\n`,
  );
  res.end("data: [DONE]\n\n");
}
