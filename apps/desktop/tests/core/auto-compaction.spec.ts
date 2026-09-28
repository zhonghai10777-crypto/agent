import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { launchDesktop, makeUserDataDir, makeWorkspace, setDeferredThreadTitleMode, startThreadFromSurface, type DesktopHarness } from "../helpers/electron-app";
import { seedCompactionAgentDir, startCompactionHttpFixture } from "../helpers/compaction-fixture";

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
