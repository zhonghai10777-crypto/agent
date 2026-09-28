import test from "node:test";
import assert from "node:assert/strict";
import { shouldCompact, DEFAULT_COMPACTION_SETTINGS, type CompactionSettings } from "@earendil-works/pi-coding-agent";
import { AUTO_COMPACT_TOKEN_BUDGET, effectiveReserveTokens, installCompactionBudget } from "../dist/compaction-budget.js";

const DEEPSEEK_V4_CONTEXT_WINDOW = 1_000_000;
/** Smallest window where `contextWindow - AUTO_COMPACT_TOKEN_BUDGET` no longer exceeds the default reserve. */
const SMALL_WINDOW_BOUNDARY = AUTO_COMPACT_TOKEN_BUDGET + DEFAULT_COMPACTION_SETTINGS.reserveTokens;

/**
 * Minimal double satisfying CompactionBudgetSession: a settingsManager whose
 * `getCompactionSettings` reads a mutable "configured reserve" (standing in
 * for settings.json, mutated the way a real `reload()` would refresh it) and
 * a mutable `model`, so tests can flip either independently.
 */
function fakeSession(configuredReserve: number, contextWindow: number | undefined) {
  let reserve = configuredReserve;
  let model = contextWindow === undefined ? undefined : { contextWindow };
  const settingsManager = {
    getCompactionSettings(): CompactionSettings {
      return { enabled: true, reserveTokens: reserve, keepRecentTokens: 20000 };
    },
  };
  return {
    settingsManager,
    get model() { return model; },
    setContextWindow: (w: number) => { model = { contextWindow: w }; },
    setConfiguredReserve: (r: number) => { reserve = r; },
  };
}

test("effectiveReserveTokens: table of S1.1-S1.3 cases", () => {
  const cases: { contextWindow: number; configuredReserve: number; expected: number; label: string }[] = [
    { contextWindow: DEEPSEEK_V4_CONTEXT_WINDOW, configuredReserve: DEFAULT_COMPACTION_SETTINGS.reserveTokens, expected: DEEPSEEK_V4_CONTEXT_WINDOW - AUTO_COMPACT_TOKEN_BUDGET, label: "1M window, default reserve -> budget wins" },
    { contextWindow: SMALL_WINDOW_BOUNDARY, configuredReserve: DEFAULT_COMPACTION_SETTINGS.reserveTokens, expected: DEFAULT_COMPACTION_SETTINGS.reserveTokens, label: "boundary window -> configured reserve wins (tie)" },
    { contextWindow: 128_000, configuredReserve: DEFAULT_COMPACTION_SETTINGS.reserveTokens, expected: DEFAULT_COMPACTION_SETTINGS.reserveTokens, label: "S1.2: small window unaffected" },
    { contextWindow: 272_384, configuredReserve: DEFAULT_COMPACTION_SETTINGS.reserveTokens, expected: DEFAULT_COMPACTION_SETTINGS.reserveTokens, label: "S1.2: exactly 272,384 unaffected" },
    { contextWindow: DEEPSEEK_V4_CONTEXT_WINDOW, configuredReserve: 800_000, expected: 800_000, label: "S1.3: explicit larger reserve wins" },
  ];
  for (const c of cases) {
    assert.equal(effectiveReserveTokens(c.contextWindow, c.configuredReserve, AUTO_COMPACT_TOKEN_BUDGET), c.expected, c.label);
  }
});

test("S1.1: shouldCompact (pi's real function) triggers above the 256K budget and not below it, for a 1M window", () => {
  const settings: CompactionSettings = {
    enabled: true,
    reserveTokens: effectiveReserveTokens(DEEPSEEK_V4_CONTEXT_WINDOW, DEFAULT_COMPACTION_SETTINGS.reserveTokens, AUTO_COMPACT_TOKEN_BUDGET),
    keepRecentTokens: 20000,
  };
  assert.equal(shouldCompact(AUTO_COMPACT_TOKEN_BUDGET, DEEPSEEK_V4_CONTEXT_WINDOW, settings), false, "at exactly the budget, no compaction yet");
  assert.equal(shouldCompact(AUTO_COMPACT_TOKEN_BUDGET + 1, DEEPSEEK_V4_CONTEXT_WINDOW, settings), true, "one token past the budget, compaction fires");
  assert.equal(shouldCompact(200_000, DEEPSEEK_V4_CONTEXT_WINDOW, settings), false, "well under the budget");
});

test("S1.2: shouldCompact behavior for windows <= 272,384 is unchanged by installCompactionBudget", () => {
  const session = fakeSession(DEFAULT_COMPACTION_SETTINGS.reserveTokens, 128_000);
  installCompactionBudget(session as never);
  const settings = session.settingsManager.getCompactionSettings();
  assert.equal(settings.reserveTokens, DEFAULT_COMPACTION_SETTINGS.reserveTokens);
  assert.equal(shouldCompact(128_000 - DEFAULT_COMPACTION_SETTINGS.reserveTokens, 128_000, settings), false);
  assert.equal(shouldCompact(128_000 - DEFAULT_COMPACTION_SETTINGS.reserveTokens + 1, 128_000, settings), true);
});

test("S1.3: an explicitly configured larger reserveTokens wins over the budget", () => {
  const session = fakeSession(800_000, DEEPSEEK_V4_CONTEXT_WINDOW);
  installCompactionBudget(session as never);
  assert.equal(session.settingsManager.getCompactionSettings().reserveTokens, 800_000);
});

test("S1.4: switching models mid-session moves the threshold to the new model's window", () => {
  const session = fakeSession(DEFAULT_COMPACTION_SETTINGS.reserveTokens, DEEPSEEK_V4_CONTEXT_WINDOW);
  installCompactionBudget(session as never);
  assert.equal(session.settingsManager.getCompactionSettings().reserveTokens, DEEPSEEK_V4_CONTEXT_WINDOW - AUTO_COMPACT_TOKEN_BUDGET);
  session.setContextWindow(128_000);
  assert.equal(
    session.settingsManager.getCompactionSettings().reserveTokens,
    DEFAULT_COMPACTION_SETTINGS.reserveTokens,
    "small window after switch: budget no longer applies",
  );
  session.setContextWindow(DEEPSEEK_V4_CONTEXT_WINDOW);
  assert.equal(
    session.settingsManager.getCompactionSettings().reserveTokens,
    DEEPSEEK_V4_CONTEXT_WINDOW - AUTO_COMPACT_TOKEN_BUDGET,
    "switching back re-applies the budget",
  );
});

test("S1.5: installCompactionBudget never touches settings.json - it only reads getCompactionSettings, never calls a setter or save", () => {
  const session = fakeSession(DEFAULT_COMPACTION_SETTINGS.reserveTokens, DEEPSEEK_V4_CONTEXT_WINDOW);
  const settingsManagerKeysBefore = Object.keys(session.settingsManager).sort();
  installCompactionBudget(session as never);
  // The only mutation installCompactionBudget performs is replacing the
  // getCompactionSettings function itself; no new property is added and no
  // other method on the object is invoked or altered.
  assert.deepEqual(Object.keys(session.settingsManager).sort(), settingsManagerKeysBefore);
});

test("installCompactionBudget is idempotent: installing twice does not double-wrap", () => {
  const session = fakeSession(DEFAULT_COMPACTION_SETTINGS.reserveTokens, DEEPSEEK_V4_CONTEXT_WINDOW);
  installCompactionBudget(session as never);
  const wrappedOnce = session.settingsManager.getCompactionSettings;
  installCompactionBudget(session as never);
  assert.equal(session.settingsManager.getCompactionSettings, wrappedOnce, "second install must be a no-op on the same settingsManager");
  assert.equal(session.settingsManager.getCompactionSettings().reserveTokens, DEEPSEEK_V4_CONTEXT_WINDOW - AUTO_COMPACT_TOKEN_BUDGET);
});

test("the wrap survives a settingsManager.reload()-style data refresh, since only the method is wrapped, not the data", () => {
  const session = fakeSession(DEFAULT_COMPACTION_SETTINGS.reserveTokens, DEEPSEEK_V4_CONTEXT_WINDOW);
  installCompactionBudget(session as never);
  const wrappedOnce = session.settingsManager.getCompactionSettings;

  // A real reload() re-reads settings.json into internal fields and never
  // reassigns getCompactionSettings; stand in for that by mutating the
  // underlying configured reserve directly, the way the double's
  // getCompactionSettings reads it.
  session.setConfiguredReserve(900_000);

  assert.equal(session.settingsManager.getCompactionSettings, wrappedOnce, "reload must not replace or re-wrap the method");
  assert.equal(
    session.settingsManager.getCompactionSettings().reserveTokens,
    900_000,
    "the wrap still reflects the freshly reloaded configured reserve (900K > budget-implied 744K)",
  );
});
