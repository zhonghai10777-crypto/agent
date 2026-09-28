import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { getDesktopState, launchDesktop, makeUserDataDir, makeWorkspace, setDeferredThreadTitleMode, startThreadFromSurface, type DesktopHarness } from "../helpers/electron-app";
import { messageText, realTokensForText, seedCompactionAgentDir, startCompactionHttpFixture } from "../helpers/compaction-fixture";
import { sessionFilePathFromCatalog } from "../helpers/session-file";

async function setup() {
  const userDataDir = await makeUserDataDir("compaction-用户-");
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("compaction-工作区");
  await seedCompactionAgentDir(agentDir);
  const reportPath = join(workspacePath, "report.txt");
  await writeFile(reportPath, "Quarterly findings: revenue grew 12%, churn dropped.", "utf8");
  const http = await startCompactionHttpFixture();
  http.setNextToolCallPath(reportPath);
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
  });
  try {
    const page = await harness.firstWindow();
    await http.install(harness);
    await setDeferredThreadTitleMode(harness);
    return { userDataDir, agentDir, workspacePath, reportPath, http, harness, page };
  } catch (error) {
    await harness.close();
    await http.close();
    throw error;
  }
}

async function closeAll(f: { readonly harness: DesktopHarness; readonly http: { close(): Promise<void> } }) {
  await f.harness.close().catch(() => {});
  await f.http.close();
}

test("auto-compaction A: threshold compaction runs, is visible in the timeline, and the summary lists the read file", async () => {
  const f = await setup();
  try {
    f.http.setSummarizationMode("hold");
    await startThreadFromSurface(f.page, { prompt: "Read report.txt and summarize it" });

    // The read_document tool call runs for real against the fixture file, and
    // the second primary reply carries usage.prompt_tokens = 300,000 - past
    // the 256K auto-compaction budget for this 1M-context fixture model - so
    // pi's own _checkCompaction triggers automatic ("threshold") compaction.
    await expect(f.page.locator(".timeline-tool--success")).toBeVisible({ timeout: 15_000 });
    await expect(f.page.locator(".timeline-item--assistant").last()).toContainText("Final answer after reading the file.", { timeout: 15_000 });

    // In-progress compaction activity is visible while the summarization
    // request is held...
    await expect(f.page.locator(".timeline-activity", { hasText: "Automatically compacting session context" })).toBeVisible({ timeout: 15_000 });

    f.http.release();

    // ...and is replaced by the success activity once it completes.
    await expect(f.page.locator(".timeline-activity", { hasText: "Session context automatically compacted" })).toBeVisible({ timeout: 15_000 });
    await expect(f.page.locator(".timeline-activity", { hasText: "Automatically compacting session context" })).toHaveCount(0);

    // The compaction summary card is visible with the desktop's own
    // <read-files> entry for the file read_document read.
    const summaryCard = f.page.locator(".timeline-item--summary-card").last();
    await expect(summaryCard).toBeVisible({ timeout: 15_000 });
    await expect(summaryCard).toContainText("Fixed compaction summary text.");
    await expect(summaryCard).toContainText("read-files");
    await expect(summaryCard).toContainText(f.reportPath);

    expect(f.http.requests.filter((r) => r.kind === "summarization")).toHaveLength(1);
  } finally {
    await closeAll(f);
  }
});

test("auto-compaction B: a failed summarization surfaces a visible failure with a reason and the session returns to idle", async () => {
  const f = await setup();
  try {
    f.http.setSummarizationMode("http500");
    await startThreadFromSurface(f.page, { prompt: "Read report.txt and summarize it" });

    await expect(f.page.locator(".timeline-item--assistant").last()).toContainText("Final answer after reading the file.", { timeout: 15_000 });

    const failedActivity = f.page.locator(".timeline-activity--error", { hasText: "Automatic compaction failed" });
    await expect(failedActivity).toBeVisible({ timeout: 15_000 });
    // A reason accompanies the failure label, not just the bare label.
    await expect(failedActivity.locator(".timeline-activity__detail")).not.toHaveText("", { timeout: 15_000 });
    await expect(f.page.locator(".timeline-activity", { hasText: "Automatically compacting session context" })).toHaveCount(0);

    // The session is idle again, not stuck "running": the primary action button
    // reverts to "Send message" (it reads "Stop run" while a run is active).
    await expect(f.page.getByTestId("send")).toHaveAttribute("aria-label", "Send message", { timeout: 15_000 });

    expect(f.http.requests.filter((r) => r.kind === "summarization")).toHaveLength(1);
  } finally {
    await closeAll(f);
  }
});

test("auto-compaction C: below the budget threshold, no compaction runs at all", async () => {
  const f = await setup();
  try {
    f.http.setNextUsage({ prompt_tokens: 200_000, completion_tokens: 40, total_tokens: 200_040 });
    await startThreadFromSurface(f.page, { prompt: "Read report.txt and summarize it" });

    await expect(f.page.locator(".timeline-item--assistant").last()).toContainText("Final answer after reading the file.", { timeout: 15_000 });

    // Give any (incorrect) auto-compaction a moment to have started, then assert it never did.
    await f.page.waitForTimeout(1_000);
    expect(f.http.requests.filter((r) => r.kind === "summarization")).toHaveLength(0);
    await expect(f.page.locator(".timeline-activity", { hasText: "Automatically compacting session context" })).toHaveCount(0);
    await expect(f.page.locator(".timeline-activity", { hasText: "Session context automatically compacted" })).toHaveCount(0);
    await expect(f.page.locator(".timeline-item--summary-card")).toHaveCount(0);
  } finally {
    await closeAll(f);
  }
});

test("auto-compaction D: a message sent while auto-compaction is running is queued, not rejected, and is delivered once compaction finishes", async () => {
  const f = await setup();
  try {
    f.http.setSummarizationMode("hold");
    await startThreadFromSurface(f.page, { prompt: "Read report.txt and summarize it" });
    await expect(f.page.locator(".timeline-item--assistant").last()).toContainText("Final answer after reading the file.", { timeout: 15_000 });
    await expect(f.page.locator(".timeline-activity", { hasText: "Automatically compacting session context" })).toBeVisible({ timeout: 15_000 });

    // Small usage for the queued follow-up's own reply so it doesn't trigger
    // a second round of compaction and complicate the assertions below.
    f.http.setNextUsage({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });
    await f.page.getByTestId("composer").fill("Follow-up while compacting");
    await f.page.getByTestId("send").click();

    // Sent while the driver still reports the session as busy compacting: it
    // must be queued (composer.tsx's isRunning check), not rejected outright
    // by sendUserMessageOnce ("already streaming") and lost.
    await expect(f.page.getByTestId("composer-error-banner")).toHaveCount(0);
    await expect(f.page.getByTestId("queued-composer-message").filter({ hasText: "Follow-up while compacting" })).toHaveCount(1);

    f.http.release();
    await expect(f.page.locator(".timeline-activity", { hasText: "Session context automatically compacted" })).toBeVisible({ timeout: 15_000 });

    // The queued follow-up is delivered once compaction finishes: a third
    // primary request reaches the fixture, its reply lands in the transcript,
    // and the queue empties.
    await expect.poll(() => f.http.requests.filter((r) => r.kind === "primary").length, { timeout: 15_000 }).toBeGreaterThanOrEqual(3);
    await expect(f.page.locator(".timeline-item--assistant", { hasText: "Final answer after reading the file." })).toHaveCount(2, { timeout: 15_000 });
    await expect(f.page.getByTestId("queued-composer-message")).toHaveCount(0);

    // And the session ends idle, not stuck "running" - no duplicate "Agent
    // finished responding" notification path left dangling either.
    await expect(f.page.getByTestId("send")).toHaveAttribute("aria-label", "Send message", { timeout: 15_000 });
  } finally {
    await closeAll(f);
  }
});

/** A CJK paragraph of ~repeats * 24 characters (a fixed 24-char sentence, repeated), for the case E documents. */
function cjkParagraph(repeats: number): string {
  return "本季度自动压缩功能校准了会话中的中文字符估算比例。".repeat(repeats);
}

test("auto-compaction E: a long Chinese-document session compacts with the real kept range near the configured keepRecentTokens", async () => {
  const userDataDir = await makeUserDataDir("compaction-calibration-用户-");
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("compaction-calibration-工作区");
  const configuredKeepRecentTokens = 20_000;
  await seedCompactionAgentDir(agentDir, { keepRecentTokens: configuredKeepRecentTokens });

  // read_document's default (part=1) page cap means each ~8,000-char
  // document only contributes its first page (~4,000 chars) per round - about
  // 2,467 real tokens/round once the fixed overhead below is added in. 26
  // rounds comfortably crosses the 256K auto-compaction budget (measured:
  // ~256.3K at round 26) while leaving a healthy calibration sample.
  const docCount = 26;
  const docPaths: string[] = [];
  for (let i = 0; i < docCount; i += 1) {
    const docPath = join(workspacePath, `中文文档-${i}.txt`);
    await writeFile(docPath, cjkParagraph(333), "utf8");
    docPaths.push(docPath);
  }

  const http = await startCompactionHttpFixture();
  // enableRealTokenizerUsage makes every primary reply's usage reflect the
  // real, growing CJK context instead of a fixed number - cases A-D never
  // call this, so their behavior is untouched.
  http.enableRealTokenizerUsage(200_000);
  http.setSummarizationMode("hold");

  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
  });
  try {
    const page = await harness.firstWindow();
    await http.install(harness);
    await setDeferredThreadTitleMode(harness);

    // One tool-call path queued right before each round's own send: the
    // fixture's tool-call queue is FIFO and consumed on the round's first
    // model response, so queuing all of them up front would let the agent
    // loop drain the whole queue inside a single turn instead of one
    // document per round.
    const compactingActivity = page.locator(".timeline-activity", { hasText: "Automatically compacting session context" });
    http.setNextToolCallPath(docPaths[0]!);
    await startThreadFromSurface(page, { prompt: `请阅读文档 中文文档-0.txt 并总结要点` });
    for (let round = 1; round < docCount; round += 1) {
      // The threshold can cross mid-loop (compaction fires right after the
      // agent_end that pushed usage past 256K, before any further prompt
      // could be sent), in which case the primary count this round expects
      // will never arrive until compaction settles - so this round's wait
      // succeeds on *either* the expected primary count or compaction
      // starting, and the check right below decides which happened.
      await expect
        .poll(
          async () => (await compactingActivity.isVisible()) || http.requests.filter((r) => r.kind === "primary").length >= round * 2,
          { timeout: 15_000 },
        )
        .toBe(true);
      if (await compactingActivity.isVisible()) break;
      http.setNextToolCallPath(docPaths[round]!);
      await page.getByTestId("composer").fill(`请阅读文档 中文文档-${round}.txt 并总结要点`);
      await page.getByTestId("send").click();
    }

    // Threshold crossed at some point during the rounds above; the timeline
    // shows the same in-progress/success pair as case A.
    await expect(compactingActivity).toBeVisible({ timeout: 20_000 });
    // This long, tool-call-heavy conversation can cut mid-turn (a "split
    // turn": the model's tool call is kept, but its own turn prefix needs a
    // second summarization call alongside the main one) - switch to
    // answering immediately so a second summarization request right after
    // release() does not sit held forever waiting for a release() that never
    // comes; cases A/B/D's simpler conversations never hit this.
    http.setSummarizationMode("success");
    http.release();
    await expect(page.locator(".timeline-activity", { hasText: "Session context automatically compacted" })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".timeline-item--summary-card").last()).toBeVisible({ timeout: 15_000 });

    // Read the compaction entry straight from the session's own JSONL (not
    // the driver cache) and measure the real (not pi-estimated) token count
    // of everything from firstKeptEntryId onward, the same way the T3 driver
    // unit test does.
    const state = await getDesktopState(page);
    let sessionRef: { workspaceId: string; sessionId: string } | undefined;
    for (const workspace of state.workspaces) {
      const session = workspace.sessions.find((candidate) => candidate.id === state.selectedSessionId);
      if (session) {
        sessionRef = { workspaceId: workspace.id, sessionId: session.id };
        break;
      }
    }
    if (!sessionRef) throw new Error("selected session not found in desktop state");
    const sessionFilePath = await sessionFilePathFromCatalog(userDataDir, sessionRef);
    const entries = (await readFile(sessionFilePath, "utf8"))
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { type: string; id: string; firstKeptEntryId?: string; message?: unknown });
    const compactionEntries = entries.filter((entry) => entry.type === "compaction");
    expect(compactionEntries.length).toBeGreaterThanOrEqual(1);
    const latestCompaction = compactionEntries[compactionEntries.length - 1]!;
    const firstKeptIndex = entries.findIndex((entry) => entry.id === latestCompaction.firstKeptEntryId);
    expect(firstKeptIndex).toBeGreaterThanOrEqual(0);

    let keptRealTokens = 0;
    for (let i = firstKeptIndex; i < entries.length; i += 1) {
      const entry = entries[i]!;
      if (entry.type !== "message") continue;
      keptRealTokens += realTokensForText(messageText(entry.message));
    }
    const ratio = keptRealTokens / configuredKeepRecentTokens;
    expect(ratio, `kept ${keptRealTokens} real tokens (${ratio.toFixed(2)}x of ${configuredKeepRecentTokens})`).toBeGreaterThanOrEqual(0.6);
    expect(ratio, `kept ${keptRealTokens} real tokens (${ratio.toFixed(2)}x of ${configuredKeepRecentTokens})`).toBeLessThanOrEqual(1.5);
  } finally {
    await harness.close().catch(() => {});
    await http.close();
  }
});
