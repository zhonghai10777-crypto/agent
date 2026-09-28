/**
 * Auto-compaction token budget for large-context models.
 *
 * pi's default compaction reserve (16,384 tokens, see DEFAULT_COMPACTION_SETTINGS
 * in @earendil-works/pi-coding-agent) is sized for the 128K-256K context windows
 * most models ship with. DeepSeek v4's 1,000,000-token window leaves that same
 * reserve so small that auto-compaction only fires at ~984K tokens - deep into
 * the model's own context, past the point where a desktop session is still
 * pleasant to summarize or resume. This module caps the *usable* context at
 * AUTO_COMPACT_TOKEN_BUDGET tokens for any model whose window is large enough
 * that the configured reserve would otherwise let more through.
 *
 * It also calibrates `keepRecentTokens` per session (see
 * estimateCalibrationFactor below): pi's own `estimateTokens` assumes chars/4
 * regardless of script, which under-counts CJK text by roughly 2x. That is out
 * of scope to fix directly - `estimateTokens` is called module-internally
 * inside pi and cannot be substituted - so this corrects the one setting that
 * *is* reachable through SettingsManager.
 */
import type { SessionEntry, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { estimateTokens, getLatestCompactionEntry, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";

/**
 * pi exports a `CompactionSettings` *type* from settings-manager.ts whose
 * fields are all optional (it doubles as the settings.json shape), which
 * does not match what `getCompactionSettings()` actually returns (all
 * fields present). Use its own return type instead of that name.
 */
type ResolvedCompactionSettings = ReturnType<SettingsManager["getCompactionSettings"]>;

/** Compact once the conversation exceeds this many tokens, for models whose context window is large enough that the configured reserve alone would not do it. */
export const AUTO_COMPACT_TOKEN_BUDGET = 256_000;

/**
 * The compaction reserve to use for a given context window.
 *
 * Returns whichever is larger: the user's explicitly configured
 * `configuredReserve`, or the reserve implied by capping usable context at
 * `budget` tokens (`contextWindow - budget`). A context window small enough
 * that `contextWindow - budget` does not exceed `configuredReserve` is left
 * untouched, and an explicitly larger configured reserve always wins.
 */
export function effectiveReserveTokens(contextWindow: number, configuredReserve: number, budget: number): number {
  const budgetReserve = contextWindow - budget;
  return budgetReserve > configuredReserve ? budgetReserve : configuredReserve;
}

/** Below this accumulated pi-estimated-token sample size, a measured factor is too noisy to trust. */
const MIN_CALIBRATION_SAMPLE_ESTIMATED_TOKENS = 2_000;
/** Below this many valid consecutive-assistant-usage pairs, a measured factor is too noisy to trust. */
const MIN_CALIBRATION_PAIRS = 2;
/**
 * Calibration only ever corrects pi's estimator *upward*. pi's own
 * shouldCompact/findCutPoint logic is written to "rather overestimate than
 * under" (see compaction.js's own comments); a factor below 1 would fight
 * that intent, and an unbounded upward factor would let one bad sample (a
 * huge pasted blob, a unit conversion mismatch) blow the window wide open.
 */
const MAX_CALIBRATION_FACTOR = 3;

/**
 * Session-level calibration for pi's chars/4 `estimateTokens` heuristic.
 *
 * pi's compaction cut-point selection (`findCutPoint`, via `keepRecentTokens`)
 * is driven entirely by `estimateTokens`, which assumes chars/4 regardless of
 * script. Real DeepSeek v4 usage from CJK-heavy sessions shows this
 * under-counts by roughly 2x (median real/estimated ratio ~1.88 across
 * measured sessions) - a `keepRecentTokens` of 20,000 was actually keeping
 * closer to 38K real tokens. `k` is the measured correction factor for the
 * *current* session, used to scale `keepRecentTokens` down so the real kept
 * range tracks what the user configured.
 *
 * Method: walk `branchEntries` from the last compaction boundary onward (an
 * earlier compaction's summary already replaced whatever came before it, so
 * comparing across that boundary would mix two different contexts), and look
 * at consecutive pairs of valid assistant-usage entries (same provider+model,
 * `stopReason` not "error"/"aborted", usage present). For each pair:
 *
 * - `deltaReal` is the growth in *prompt* size between the two calls -
 *   `usage.input + usage.cacheRead + usage.cacheWrite` (deliberately not
 *   `totalTokens`/`calculateContextTokens`, which also count the *output* of
 *   each call - that is not context growth).
 * - `deltaEst` is pi's own `estimateTokens` summed over every message that
 *   entered context between the two calls (the earlier assistant message
 *   itself, plus everything up to but not including the later one).
 *
 * Using a *delta* rather than the absolute prompt size is what makes this
 * measurement valid at all: pi's `estimateTokens` only ever runs over
 * `AgentMessage`s, and the system prompt and tool schemas pi sends with every
 * request are not in that message list - they are a large, roughly constant
 * per-request overhead with no `estimateTokens` counterpart. Comparing
 * absolute `usage.input` against the message list's estimate would conflate
 * "pi's per-message estimate is off by some factor" with "there's a chunk of
 * real tokens with no estimate at all". Subtracting consecutive real prompt
 * sizes cancels that fixed overhead, isolating the per-message factor.
 *
 * `k = sum(deltaReal) / sum(deltaEst)`, clamped to `[1, MAX_CALIBRATION_FACTOR]`.
 * Returns `1` (no calibration) when the accumulated sample is too small to
 * trust (`sum(deltaEst) < MIN_CALIBRATION_SAMPLE_ESTIMATED_TOKENS` or fewer
 * than `MIN_CALIBRATION_PAIRS` valid pairs) - this also covers a session with
 * no assistant turns yet, or one that just compacted.
 *
 * Note on thinking content: whether a provider echoes reasoning/thinking
 * blocks back in later requests changes what actually lands in
 * `usage.input`/`cacheRead` for the *next* call, and therefore changes `k` -
 * but that is exactly the quantity pi's own `findCutPoint` needs corrected,
 * since it estimates the same message list `estimateTokens` does. `k`
 * reflects "how wrong is pi's estimator for what pi itself is about to
 * measure", not some independent ground truth, so this is consistent by
 * construction rather than a source of drift.
 */
export function estimateCalibrationFactor(branchEntries: readonly SessionEntry[]): number {
  const latestCompaction = getLatestCompactionEntry(branchEntries as SessionEntry[]);
  const boundaryStart = latestCompaction
    ? branchEntries.findIndex((entry) => entry.id === latestCompaction.id) + 1
    : 0;

  let sumDeltaReal = 0;
  let sumDeltaEst = 0;
  let validPairs = 0;
  let previous: { readonly promptSize: number; readonly provider: string; readonly model: string; readonly index: number } | undefined;

  for (let index = boundaryStart; index < branchEntries.length; index += 1) {
    const entry = branchEntries[index];
    if (!entry || entry.type !== "message" || entry.message.role !== "assistant") continue;
    const message = entry.message;
    const usage = message.usage;
    if (!usage || message.stopReason === "error" || message.stopReason === "aborted") continue;
    const promptSize = (usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);
    if (promptSize <= 0) continue;

    if (previous && previous.provider === message.provider && previous.model === message.model) {
      const deltaReal = promptSize - previous.promptSize;
      if (deltaReal > 0) {
        let deltaEst = 0;
        for (let between = previous.index; between < index; between += 1) {
          for (const contextMessage of sessionEntryToContextMessages(branchEntries[between] as SessionEntry)) {
            deltaEst += estimateTokens(contextMessage);
          }
        }
        if (deltaEst > 0) {
          sumDeltaReal += deltaReal;
          sumDeltaEst += deltaEst;
          validPairs += 1;
        }
      }
    }
    previous = { promptSize, provider: message.provider, model: message.model, index };
  }

  if (validPairs < MIN_CALIBRATION_PAIRS || sumDeltaEst < MIN_CALIBRATION_SAMPLE_ESTIMATED_TOKENS) return 1;
  const k = sumDeltaReal / sumDeltaEst;
  return Math.min(MAX_CALIBRATION_FACTOR, Math.max(1, k));
}

/** The branch-reading surface `estimateCalibrationFactor`'s cache needs; pi's own `SessionManager` satisfies this. */
export type CalibrationBranchSource = Pick<SessionManager, "getBranch" | "getLeafId">;

/**
 * Memoizes a calibration factor computation by branch leaf id + entry count.
 * `getCompactionSettings()` is read on every context-usage refresh (turn end,
 * every assistant message, compaction start/end - see session-supervisor.ts),
 * not only right before a compaction decision, so recomputing
 * `estimateCalibrationFactor` by walking the whole branch on every call would
 * turn an O(1) settings read into an O(branch length) one on a hot path. The
 * leaf id and entry count are cheap to read and change exactly when the
 * branch's tail does (a new message, a fork, a compaction), so comparing
 * them is sufficient to know the cached factor is still valid.
 *
 * `compute` defaults to `estimateCalibrationFactor` and is otherwise
 * injectable so tests can substitute a call-counting wrapper to prove the
 * cache actually skips recomputation rather than asserting on timing.
 */
export function createCalibratedFactorCache(
  compute: (branchEntries: readonly SessionEntry[]) => number = estimateCalibrationFactor,
): (branchSource: CalibrationBranchSource) => number {
  let cachedLeafId: string | null | undefined;
  let cachedEntryCount = -1;
  let cachedFactor = 1;
  let hasCached = false;
  return (branchSource: CalibrationBranchSource): number => {
    const leafId = branchSource.getLeafId();
    const branch = branchSource.getBranch();
    if (hasCached && leafId === cachedLeafId && branch.length === cachedEntryCount) {
      return cachedFactor;
    }
    cachedLeafId = leafId;
    cachedEntryCount = branch.length;
    cachedFactor = compute(branch);
    hasCached = true;
    return cachedFactor;
  };
}

/** Session shape `installCompactionBudget` needs: pi's own `AgentSession` satisfies this. */
export interface CompactionBudgetSession {
  readonly settingsManager: SettingsManager;
  readonly sessionManager: CalibrationBranchSource;
  readonly model?: { readonly contextWindow: number } | undefined;
}

/**
 * Settings managers already wrapped, so installing again (reload, reattach)
 * on the same instance is a no-op rather than double-wrapping.
 */
const installedBudgets = new WeakSet<SettingsManager>();

/**
 * Wrap `session.settingsManager.getCompactionSettings` so its `reserveTokens`
 * follows `AUTO_COMPACT_TOKEN_BUDGET` for whatever model the session currently
 * has selected, and its `keepRecentTokens` follows this session's measured
 * calibration factor (see `estimateCalibrationFactor` above).
 *
 * Wraps the *method*, not the settings data, so the adjustment survives
 * `settingsManager.reload()` (which only reloads the underlying settings
 * fields, never reassigns methods) and keeps following model switches made
 * mid-session, since `session.model` is read fresh on every call.
 *
 * `keepRecentTokens` calibration is independent of `contextWindow` and is
 * applied even when there is no model/contextWindow to compute a reserve
 * budget from - the two corrections address unrelated pi defaults and there
 * is no reason the token-estimate fix should wait on a model being selected.
 *
 * Known trade-off (see pi's compaction/utils.ts `generateSummaryWithUsage`):
 * the summarization call's `maxTokens` is `min(0.8 * reserveTokens,
 * model.maxTokens)`, so enlarging `reserveTokens` also raises that ceiling.
 * It is only a ceiling - actual summary length is still governed by the
 * summarization prompt - so this does not by itself make summaries longer.
 */
export function installCompactionBudget(session: CompactionBudgetSession): void {
  const settingsManager = session.settingsManager;
  if (!settingsManager || installedBudgets.has(settingsManager)) return;
  installedBudgets.add(settingsManager);
  const getCalibratedFactor = createCalibratedFactorCache();
  const original = settingsManager.getCompactionSettings.bind(settingsManager);
  settingsManager.getCompactionSettings = (): ResolvedCompactionSettings => {
    const settings = original();
    const contextWindow = session.model?.contextWindow ?? 0;
    const reserveTokens = contextWindow > 0
      ? effectiveReserveTokens(contextWindow, settings.reserveTokens, AUTO_COMPACT_TOKEN_BUDGET)
      : settings.reserveTokens;
    const k = getCalibratedFactor(session.sessionManager);
    const keepRecentTokens = Math.max(1, Math.round(settings.keepRecentTokens / k));
    return { ...settings, reserveTokens, keepRecentTokens };
  };
}
