import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  getLatestCompactionEntry,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createCompatResourceLoader } from "../dist/pi-compat/resource-loader-adapter.js";
import { createCalibratedFactorCache, estimateCalibrationFactor, installCompactionBudget } from "../dist/compaction-budget.js";

// ============================================================================
// Fixture builders for the pure-function tests: plain objects shaped like
// pi's SessionEntry/AgentMessage, matching estimateTokens' own switch
// (compaction.js) so pi-estimated sizes are exact and predictable by
// character count (chars/4, ceil'd).
// ============================================================================

function zeroCost() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

function usage(input: number, options: { output?: number; cacheRead?: number; cacheWrite?: number } = {}) {
  const output = options.output ?? 10;
  const cacheRead = options.cacheRead ?? 0;
  const cacheWrite = options.cacheWrite ?? 0;
  return { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite, cost: zeroCost() };
}

function assistantMessage(text: string, promptInput: number, options: { stopReason?: string; provider?: string; model?: string; usage?: ReturnType<typeof usage> | null } = {}) {
  return {
    role: "assistant" as const,
    api: "openai-completions",
    provider: options.provider ?? "provider-a",
    model: options.model ?? "model-a",
    content: [{ type: "text" as const, text }],
    ...(options.usage === null ? {} : { usage: options.usage ?? usage(promptInput) }),
    stopReason: options.stopReason ?? "stop",
    timestamp: Date.now(),
  };
}

function userMessage(text: string) {
  return { role: "user" as const, content: [{ type: "text" as const, text }], timestamp: Date.now() };
}

function toolResultMessage(text: string) {
  return { role: "toolResult" as const, toolCallId: "call-1", toolName: "read_document", content: [{ type: "text" as const, text }], timestamp: Date.now() };
}

let nextEntryId = 0;
function messageEntry(message: unknown) {
  nextEntryId += 1;
  return { type: "message" as const, id: `entry-${nextEntryId}`, parentId: null, timestamp: new Date().toISOString(), message };
}

function compactionBoundaryEntry() {
  nextEntryId += 1;
  return { type: "compaction" as const, id: `entry-${nextEntryId}`, parentId: null, timestamp: new Date().toISOString(), summary: "prior summary", firstKeptEntryId: "entry-0", tokensBefore: 0 };
}

/** A CJK string of exactly `chars` characters (repeats a 4-char sentence fragment), so estimateTokens (chars/4, ceil'd) is exact and predictable. */
function cjkChars(chars: number): string {
  const unit = "会话压缩"; // 4 chars
  return unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);
}

test("estimateCalibrationFactor: T2 too few valid pairs -> k = 1 (single assistant message)", () => {
  const branch = [messageEntry(assistantMessage("hello", 5000))];
  assert.equal(estimateCalibrationFactor(branch), 1);
});

test("estimateCalibrationFactor: T2 no assistant messages at all -> k = 1", () => {
  const branch = [messageEntry(userMessage("hi"))];
  assert.equal(estimateCalibrationFactor(branch), 1);
});

test("estimateCalibrationFactor: T2 sample below the 2,000-estimated-token floor -> k = 1", () => {
  // Two valid pairs, but each between-window is tiny (well under 2,000 combined).
  const branch = [
    messageEntry(assistantMessage("", 5000)),
    messageEntry(toolResultMessage(cjkChars(40))), // estimateTokens = ceil(40/4) = 10
    messageEntry(assistantMessage("", 5100)),
    messageEntry(toolResultMessage(cjkChars(40))),
    messageEntry(assistantMessage("", 5200)),
  ];
  assert.equal(estimateCalibrationFactor(branch), 1, "sumDeltaEst = 20, far under the 2,000 floor");
});

test("estimateCalibrationFactor: T1 measures k from consecutive assistant-usage deltas using pi's own estimateTokens", () => {
  // Two valid pairs, each contributing exactly 1,200 pi-estimated tokens
  // (4,800-char CJK tool result) and 2,640 real tokens of growth ->
  // k = 2,640 / 1,200 = 2.2 for both pairs, so the aggregate is exact.
  const branch = [
    messageEntry(assistantMessage("", 5000)),
    messageEntry(toolResultMessage(cjkChars(4800))), // estimateTokens = ceil(4800/4) = 1200
    messageEntry(assistantMessage("", 5000 + 2640)), // deltaReal = 2640
    messageEntry(toolResultMessage(cjkChars(4800))),
    messageEntry(assistantMessage("", 5000 + 2640 + 2640)),
  ];
  assert.equal(estimateCalibrationFactor(branch), 2.2);
});

test("estimateCalibrationFactor: only entries after the latest compaction boundary are used", () => {
  // Before the boundary: a wildly different (and wrong, if used) ratio.
  const before = [
    messageEntry(assistantMessage("", 1_000_000)),
    messageEntry(toolResultMessage(cjkChars(40))), // estimateTokens = 10
    messageEntry(assistantMessage("", 2_000_000)), // would imply k = 1,000,000 / 10 if not excluded
  ];
  const boundary = compactionBoundaryEntry();
  // After the boundary: the same clean 2.2 pair as the previous test.
  const after = [
    messageEntry(assistantMessage("", 5000)),
    messageEntry(toolResultMessage(cjkChars(4800))),
    messageEntry(assistantMessage("", 5000 + 2640)),
    messageEntry(toolResultMessage(cjkChars(4800))),
    messageEntry(assistantMessage("", 5000 + 2640 + 2640)),
  ];
  const branch = [...before, boundary, ...after];
  assert.equal(estimateCalibrationFactor(branch), 2.2, "pre-boundary data must not leak into the measurement");
});

test("estimateCalibrationFactor: an error/aborted assistant message is never used as a pair endpoint", () => {
  // Four valid assistants (A1, A3, A4 below - "A2" is the error one) plus one
  // error response sandwiched between the first two. MIN_CALIBRATION_PAIRS
  // is 2, so this needs at least two valid pairs *surviving* the skip: A1-A3
  // (spanning across the skipped error entry) and A3-A4.
  const branch = [
    messageEntry(assistantMessage("", 5000)), // A1
    messageEntry(toolResultMessage(cjkChars(4800))), // estimateTokens = 1200
    // A huge, bogus prompt size on an error response - would corrupt the
    // measurement badly if treated as a valid endpoint; its own (empty) text
    // still contributes 0 to the "between" sum either way.
    messageEntry(assistantMessage("", 9_000_000, { stopReason: "error" })),
    messageEntry(toolResultMessage(cjkChars(4800))), // estimateTokens = 1200
    messageEntry(assistantMessage("", 5000 + 5280)), // A3: deltaReal (A1->A3) = 5280, deltaEst = 2400 -> 2.2
    messageEntry(toolResultMessage(cjkChars(4800))), // estimateTokens = 1200
    messageEntry(assistantMessage("", 5000 + 5280 + 2640)), // A4: deltaReal (A3->A4) = 2640, deltaEst = 1200 -> 2.2
  ];
  assert.equal(estimateCalibrationFactor(branch), 2.2);
});

test("estimateCalibrationFactor: a provider/model switch does not form a pair across it", () => {
  const branch = [
    messageEntry(assistantMessage("", 5000, { provider: "provider-a", model: "model-a" })),
    messageEntry(toolResultMessage(cjkChars(4800))),
    // Different model: switching here must not pair with the entry above.
    messageEntry(assistantMessage("", 500_000, { provider: "provider-b", model: "model-b" })),
    messageEntry(toolResultMessage(cjkChars(4800))),
    messageEntry(assistantMessage("", 500_000 + 2640, { provider: "provider-b", model: "model-b" })),
  ];
  // Only the second pair (both provider-b/model-b) is valid: one pair, not
  // enough for MIN_CALIBRATION_PAIRS (2), so this returns 1.
  assert.equal(estimateCalibrationFactor(branch), 1);
});

test("estimateCalibrationFactor: a non-positive delta (prompt size did not grow) is skipped, not counted as k < 1", () => {
  const branch = [
    messageEntry(assistantMessage("", 5000)),
    messageEntry(toolResultMessage(cjkChars(4800))),
    messageEntry(assistantMessage("", 4000)), // shrank: deltaReal <= 0, skipped
    messageEntry(toolResultMessage(cjkChars(4800))),
    messageEntry(assistantMessage("", 4000)), // flat: deltaReal <= 0, skipped
  ];
  assert.equal(estimateCalibrationFactor(branch), 1, "no valid pairs survive, so this is the insufficient-sample case, not a measured k < 1");
});

test("estimateCalibrationFactor: clamps to MAX (3) when the measured ratio is far above it", () => {
  const branch = [
    messageEntry(assistantMessage("", 5000)),
    messageEntry(toolResultMessage(cjkChars(4000))), // estimateTokens = 1000
    messageEntry(assistantMessage("", 5000 + 20_000)), // deltaReal = 20,000 -> ratio 20
    messageEntry(toolResultMessage(cjkChars(4000))),
    messageEntry(assistantMessage("", 5000 + 20_000 + 20_000)),
  ];
  assert.equal(estimateCalibrationFactor(branch), 3);
});

test("estimateCalibrationFactor: never returns below 1 even if the measured ratio is under 1", () => {
  const branch = [
    messageEntry(assistantMessage("", 5000)),
    messageEntry(toolResultMessage(cjkChars(4000))), // estimateTokens = 1000
    messageEntry(assistantMessage("", 5000 + 500)), // deltaReal = 500 -> ratio 0.5
    messageEntry(toolResultMessage(cjkChars(4000))),
    messageEntry(assistantMessage("", 5000 + 500 + 500)),
  ];
  assert.equal(estimateCalibrationFactor(branch), 1, "pi's estimator is meant to be corrected upward only, never down");
});

// ============================================================================
// Cache (T5)
// ============================================================================

function fakeBranchSource(initialLeafId: string, initialLength: number) {
  let leafId: string | null = initialLeafId;
  let length = initialLength;
  let getBranchCalls = 0;
  return {
    getBranch: () => { getBranchCalls += 1; return Array.from({ length }, (_, i) => messageEntry(userMessage(String(i)))); },
    getLeafId: () => leafId,
    setLeafId: (next: string | null) => { leafId = next; },
    setLength: (next: number) => { length = next; },
    get getBranchCallCount() { return getBranchCalls; },
  };
}

test("createCalibratedFactorCache: does not recompute (or even read the branch) while the leaf id is unchanged", () => {
  let calls = 0;
  const cache = createCalibratedFactorCache(() => { calls += 1; return 2; });
  const source = fakeBranchSource("leaf-1", 5);
  assert.equal(cache(source), 2);
  assert.equal(cache(source), 2);
  assert.equal(cache(source), 2);
  assert.equal(calls, 1, "three reads of an unchanged branch must compute exactly once");
  assert.equal(source.getBranchCallCount, 1, "getBranch() (an O(branch length) walk in pi's own SessionManager) must only be read on the first, cache-populating call");
});

test("createCalibratedFactorCache: an entry-count change alone (same leaf id) is not a real branch mutation and is not recomputed", () => {
  // A session's leaf id changes on every branch mutation (new message, fork,
  // compaction), so "same leaf id, different length" cannot happen for a
  // real SessionManager - this documents that the cache intentionally does
  // not pay for a getBranch() call to guard against a case that isn't real.
  let calls = 0;
  const cache = createCalibratedFactorCache(() => { calls += 1; return 2; });
  const source = fakeBranchSource("leaf-1", 5);
  cache(source);
  source.setLength(6);
  cache(source);
  assert.equal(calls, 1);
});

test("createCalibratedFactorCache: recomputes when the leaf id changes even if the length happens to match", () => {
  let calls = 0;
  const cache = createCalibratedFactorCache(() => { calls += 1; return 2; });
  const source = fakeBranchSource("leaf-1", 5);
  cache(source);
  source.setLeafId("leaf-2");
  cache(source);
  assert.equal(calls, 2);
});

// ============================================================================
// T3 integration: a real AgentSession + a fake provider whose usage is
// computed from a real per-character tokenizer formula (CJK ~0.6 tok/char,
// everything else ~0.25 tok/char, matching the plan's measured DeepSeek v4
// ratio), plus a fixed 5,000-token system/tool-schema overhead added only to
// *usage*, never to the message list - exactly the "fixed overhead pi's
// estimateTokens has no counterpart for" scenario estimateCalibrationFactor's
// delta design exists to cancel out.
// ============================================================================

const SYSTEM_OVERHEAD_TOKENS = 5000;

function isCjkCodePoint(codePoint: number): boolean {
  return (codePoint >= 0x4e00 && codePoint <= 0x9fff) || (codePoint >= 0x3400 && codePoint <= 0x4dbf) || (codePoint >= 0xf900 && codePoint <= 0xfaff);
}

/** The "real tokenizer" stand-in these tests calibrate against: not pi's chars/4, a different, fixed-but-script-aware rate. */
function realTokensForText(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (isCjkCodePoint(ch.codePointAt(0) ?? 0)) cjk += 1;
    else other += 1;
  }
  return cjk * 0.6 + other * 0.25;
}

function messageText(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") text += block.text;
    else if (block?.type === "toolCall") text += `${block.name ?? ""}${JSON.stringify(block.arguments ?? {})}`;
    else if (block?.type === "thinking" && typeof block.thinking === "string") text += block.thinking;
  }
  return text;
}

function realTokensForMessages(messages: readonly unknown[]): number {
  let total = 0;
  for (const message of messages) total += realTokensForText(messageText(message));
  return total;
}

const calibrationModel = {
  id: "calibration-test-model",
  name: "Calibration Test Model",
  provider: "calibration-test",
  api: "openai-completions",
  baseUrl: "https://example.invalid",
  reasoning: false,
  input: ["text"],
  contextWindow: 1_000_000,
  maxTokens: 384_000,
  cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
};

/** A round of near-pure-CJK document content, long enough to matter but small enough for many rounds to give fine cut-point granularity. */
function cjkParagraph(sentenceRepeats: number): string {
  return "本季度自动压缩功能校准了会话中的中文字符估算比例。".repeat(sentenceRepeats);
}

/**
 * A real pi AgentSession over N rounds of "read a CJK tool result, then
 * reply" - usage is computed by the real per-character formula above, plus a
 * fixed per-request overhead never reflected in the message list, so the
 * only way to recover the real per-message rate is via consecutive-usage
 * deltas (exactly what estimateCalibrationFactor does).
 */
async function makeCalibrationSession(label: string, options: { rounds?: number; withCalibration?: boolean } = {}) {
  const rounds = options.rounds ?? 30;
  const dir = await realpath(await mkdtemp(join(tmpdir(), `compaction-calibration-${label}-`)));
  const agentDir = join(dir, "agent");
  await mkdir(agentDir);
  const credentials = { async read() { return undefined; }, async list() { return []; }, async modify() {}, async delete() {} };
  const runtime = await ModelRuntime.create({ modelsPath: null, credentials, refreshOnCreate: false });
  runtime.registerProvider("calibration-test", {
    baseUrl: calibrationModel.baseUrl,
    api: calibrationModel.api,
    apiKey: "test-account-key",
    models: [{ ...calibrationModel }],
    streamSimple(requestModel: typeof calibrationModel, context: { messages: readonly unknown[] }) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const input = Math.round(realTokensForMessages(context.messages)) + SYSTEM_OVERHEAD_TOKENS;
        const message = {
          role: "assistant", api: requestModel.api, provider: requestModel.provider, model: requestModel.id,
          content: [{ type: "text", text: "好的，已阅读文档。" }],
          usage: { input, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: input + 30, cost: zeroCost() },
          stopReason: "stop", timestamp: Date.now(),
        };
        stream.push({ type: "start", partial: message });
        stream.push({ type: "text_delta", contentIndex: 0, delta: "好的，已阅读文档。", partial: message });
        stream.push({ type: "done", reason: "stop", message });
      });
      return stream;
    },
  });
  const selectedModel = runtime.getModel("calibration-test", calibrationModel.id);
  assert.ok(selectedModel);
  const configuredKeepRecentTokens = 20_000;
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true, reserveTokens: 16, keepRecentTokens: configuredKeepRecentTokens },
    retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 },
  });
  const loader = createCompatResourceLoader({ cwd: dir, agentDir, settingsManager, noExtensions: true, noSkills: true });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: dir, agentDir, modelRuntime: runtime, model: selectedModel, thinkingLevel: "off", settingsManager,
    sessionManager: SessionManager.create(dir, join(dir, "sessions")), resourceLoader: loader, tools: [],
  });
  await session.bindExtensions({});
  if (options.withCalibration) installCompactionBudget(session);

  for (let round = 0; round < rounds; round += 1) {
    // Each prompt's own text is small (Latin) - the CJK mass driving k comes
    // from the fake tool result folded into the reply below via a plain user
    // turn, keeping this test independent of any specific desktop tool.
    // ~420 repeats of a 24-char sentence is ~10,080 chars -> pi's own chars/4
    // estimate is ~2,520 tokens/round; 30 rounds comfortably clears both the
    // calibrated (~8,333) and uncalibrated (20,000) keepRecentTokens
    // thresholds several times over, leaving plenty to discard.
    await session.prompt(`第 ${round} 轮：${cjkParagraph(420)}`);
  }
  return { dir, session, configuredKeepRecentTokens, close: async () => { await session.abort(); session.dispose(); } };
}

/** Real (per-character-formula) token count of whatever a compaction kept, read back from the session's own branch. */
function realKeptTokensAfterCompaction(session: { sessionManager: { getBranch(): readonly unknown[] } }): number {
  const branch = session.sessionManager.getBranch() as any[];
  const compactionEntry = getLatestCompactionEntry(branch);
  assert.ok(compactionEntry, "a compaction entry must exist");
  const firstKeptIndex = branch.findIndex((entry) => entry.id === compactionEntry.firstKeptEntryId);
  assert.ok(firstKeptIndex >= 0, "firstKeptEntryId must resolve to an entry on the branch");
  let total = 0;
  for (let i = firstKeptIndex; i < branch.length; i += 1) {
    for (const message of sessionEntryToContextMessages(branch[i])) total += realTokensForText(messageText(message));
  }
  return total;
}

test("T3: calibrated keepRecentTokens keeps real tokens within 0.6x-1.5x of the configured value; uncalibrated overshoots it", { timeout: 30_000 }, async () => {
  const calibrated = await makeCalibrationSession("calibrated", { withCalibration: true });
  const uncalibrated = await makeCalibrationSession("uncalibrated", { withCalibration: false });
  try {
    await calibrated.session.compact();
    await uncalibrated.session.compact();

    const calibratedKept = realKeptTokensAfterCompaction(calibrated.session);
    const uncalibratedKept = realKeptTokensAfterCompaction(uncalibrated.session);
    const target = calibrated.configuredKeepRecentTokens;

    const calibratedRatio = calibratedKept / target;
    const uncalibratedRatio = uncalibratedKept / target;

    assert.ok(
      calibratedRatio >= 0.6 && calibratedRatio <= 1.5,
      `calibrated kept ${calibratedKept} real tokens (${calibratedRatio.toFixed(2)}x of ${target}); expected within 0.6x-1.5x`,
    );
    assert.ok(
      uncalibratedRatio > 1.5,
      `uncalibrated kept ${uncalibratedKept} real tokens (${uncalibratedRatio.toFixed(2)}x of ${target}); expected to exceed 1.5x, proving calibration changes the outcome`,
    );
  } finally {
    await calibrated.close();
    await uncalibrated.close();
  }
});
