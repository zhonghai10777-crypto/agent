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
 */
import type { SettingsManager } from "@earendil-works/pi-coding-agent";

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

/** Session shape `installCompactionBudget` needs: pi's own `AgentSession` satisfies this. */
export interface CompactionBudgetSession {
  readonly settingsManager: SettingsManager;
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
 * has selected.
 *
 * Wraps the *method*, not the settings data, so the adjustment survives
 * `settingsManager.reload()` (which only reloads the underlying settings
 * fields, never reassigns methods) and keeps following model switches made
 * mid-session, since `session.model` is read fresh on every call.
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
  const original = settingsManager.getCompactionSettings.bind(settingsManager);
  settingsManager.getCompactionSettings = (): ResolvedCompactionSettings => {
    const settings = original();
    const contextWindow = session.model?.contextWindow ?? 0;
    if (!(contextWindow > 0)) return settings;
    return { ...settings, reserveTokens: effectiveReserveTokens(contextWindow, settings.reserveTokens, AUTO_COMPACT_TOKEN_BUDGET) };
  };
}
