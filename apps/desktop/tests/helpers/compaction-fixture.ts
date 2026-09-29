import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  launchDesktop,
  makeGitWorkspace,
  makeUserDataDir,
  makeWorkspace,
  setDeferredThreadTitleMode,
  type DesktopHarness,
} from "./electron-app";

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

function isCjkCodePoint(codePoint: number): boolean {
  return (codePoint >= 0x4e00 && codePoint <= 0x9fff) || (codePoint >= 0x3400 && codePoint <= 0x4dbf) || (codePoint >= 0xf900 && codePoint <= 0xfaff);
}

/**
 * A "real tokenizer" stand-in used only when a fixture opts into
 * `realTokenizerUsage` (case E) - CJK ~0.6 tok/char, everything else ~0.25,
 * matching the plan's measured DeepSeek v4 ratio. Not used by cases A-D,
 * which keep their fixed `nextUsage` values unchanged.
 */
export function realTokensForText(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (isCjkCodePoint(ch.codePointAt(0) ?? 0)) cjk += 1;
    else other += 1;
  }
  return cjk * 0.6 + other * 0.25;
}

export function messageText(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") text += block.text;
    else if (block?.type === "tool_calls" || block?.type === "toolCall") text += `${block.name ?? ""}${JSON.stringify(block.arguments ?? block.function?.arguments ?? {})}`;
  }
  return text;
}

/** Real-tokenizer prompt size for a full request body's message list (case E only). */
export function realTokensForRequestMessages(messages: readonly unknown[]): number {
  let total = 0;
  for (const message of messages) {
    total += realTokensForText(messageText(message));
    const toolCalls = (message as { tool_calls?: readonly unknown[] })?.tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const call of toolCalls) {
        const fn = (call as { function?: { name?: string; arguments?: string } })?.function;
        total += realTokensForText(`${fn?.name ?? ""}${fn?.arguments ?? ""}`);
      }
    }
  }
  return total;
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
  const toolCallQueue: Array<{ readonly name: string; readonly arguments: Record<string, unknown> }> = [];
  let nextReplyStream: { readonly chunks: readonly string[]; readonly pause: SsePause | undefined } | undefined;
  let nextUsage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } = {
    prompt_tokens: 300_000,
    completion_tokens: 40,
    total_tokens: 300_040,
  };
  let nextReplyText = "Final answer after reading the file.";
  let summarizationMode: "success" | "http500" | "hold" = "success";
  let summaryText = "Fixed compaction summary text.";
  // Case E only (realTokenizerUsage): computes usage.input from the actual
  // request body via realTokensForRequestMessages, plus this fixed overhead
  // (standing in for a system prompt/tool schemas, never reflected in the
  // message list pi's own estimator sees). undefined means "off": cases A-D
  // keep using the fixed nextUsage above, completely unaffected.
  let realTokenizerOverhead: number | undefined;

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
        void writeSseCompletion(res, body.model, { content: summaryText }, { prompt_tokens: 500, completion_tokens: 30, total_tokens: 530 });
      };
      if (summarizationMode === "hold") held.push(respond);
      else respond();
      return;
    }

    primaryCallCount += 1;
    if (toolCallQueue.length > 0) {
      const call = toolCallQueue.shift()!;
      void writeSseCompletion(res, body.model, {
        tool_calls: [
          { index: 0, id: `${call.name}-call-${primaryCallCount}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } },
        ],
      });
      return;
    }
    if (nextReplyStream) {
      const plan = nextReplyStream;
      nextReplyStream = undefined;
      await writeSseCompletion(res, body.model, { content: plan.chunks }, nextUsage, plan.pause);
      return;
    }
    if (realTokenizerOverhead !== undefined) {
      const input = Math.round(realTokensForRequestMessages(body.messages ?? [])) + realTokenizerOverhead;
      void writeSseCompletion(res, body.model, { content: nextReplyText }, { prompt_tokens: input, completion_tokens: 30, total_tokens: input + 30 });
      return;
    }
    void writeSseCompletion(res, body.model, { content: nextReplyText }, nextUsage);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };

  return {
    requests,
    /** The next primary response not otherwise queued is a read_document tool call for this path. Queues (FIFO); call once per round that should start with a tool call. */
    setNextToolCallPath(path: string) {
      toolCallQueue.push({ name: "read_document", arguments: { path } });
    },
    /** Like setNextToolCallPath, for any tool: the next primary response not otherwise queued calls `name` with `args`. */
    setNextToolCall(name: string, args: Record<string, unknown>) {
      toolCallQueue.push({ name, arguments: args });
    },
    /**
     * The next plain reply streams `chunks` as separate SSE content deltas.
     * With `pauseAfter`, the stream holds after that many chunks until
     * release(), so a test can inspect a reply mid-stream.
     */
    setNextReplyStream(chunks: readonly string[], options: { readonly pauseAfter?: number } = {}) {
      const pause = options.pauseAfter === undefined
        ? undefined
        : { afterChunks: options.pauseAfter, until: new Promise<void>((resolve) => held.push(resolve)) };
      nextReplyStream = { chunks, pause };
    },
    setNextUsage(usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }) {
      nextUsage = usage;
    },
    setNextReplyText(text: string) {
      nextReplyText = text;
    },
    /**
     * Case E only: switch primary usage from the fixed `nextUsage` to a
     * dynamic computation from the actual request body (see
     * realTokensForRequestMessages), plus `overheadTokens` added
     * unconditionally (standing in for a system prompt/tool schemas outside
     * the message list). Cases A-D never call this, so their fixed-usage
     * behavior is unchanged.
     */
    enableRealTokenizerUsage(overheadTokens: number) {
      realTokenizerOverhead = overheadTokens;
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

/**
 * Launches the desktop against a freshly seeded fixture agentDir and a running
 * HTTP fixture, with auto-title requests deferred so the fixture only ever
 * sees the requests a test drives. `close()` tears both down.
 */
export async function launchWithCompactionFixture(label: string, options: { readonly git?: boolean } = {}) {
  const userDataDir = await makeUserDataDir(`${label}-`);
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await (options.git ? makeGitWorkspace(label) : makeWorkspace(label));
  await seedCompactionAgentDir(agentDir);
  const http = await startCompactionHttpFixture();
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
  });
  const close = async () => {
    await harness.close().catch(() => {});
    await http.close();
  };
  try {
    const page = await harness.firstWindow();
    await http.install(harness);
    await setDeferredThreadTitleMode(harness);
    return { userDataDir, agentDir, workspacePath, http, harness, page, close };
  } catch (error) {
    await close();
    throw error;
  }
}

interface SsePause {
  readonly afterChunks: number;
  readonly until: Promise<void>;
}

async function writeSseCompletion(
  res: import("node:http").ServerResponse,
  model: string,
  delta: { content?: string | readonly string[]; tool_calls?: unknown[] },
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number },
  pause?: SsePause,
): Promise<void> {
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
    const contents = typeof delta.content === "object" ? delta.content : [delta.content ?? ""];
    for (const [index, content] of contents.entries()) {
      if (res.destroyed) return;
      send({ content });
      // A multi-chunk reply is spaced out so each delta arrives as its own
      // network read, the way a real provider streams.
      if (contents.length > 1) await new Promise((resolve) => setTimeout(resolve, 5));
      if (pause?.afterChunks === index + 1) await pause.until;
    }
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
