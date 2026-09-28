import { expect, test } from "@playwright/test";
import { startThreadFromSurface } from "../helpers/electron-app";
import { launchWithCompactionFixture } from "../helpers/compaction-fixture";

// Mid-message, the timeline is built from assistant deltas alone: the driver
// publishes at most one session snapshot per second while a reply streams.
// This proves the reply still renders progressively, and that a transcript
// snapshot arriving mid-stream never duplicates text a delta also carries.
test("streams a long reply into the timeline progressively, with no duplicated or missing text", async () => {
  const f = await launchWithCompactionFixture("streaming-工作区");
  try {
    // Far below the auto-compaction budget, so no compaction interleaves.
    f.http.setNextUsage({ prompt_tokens: 120, completion_tokens: 400, total_tokens: 520 });
    const chunks = Array.from({ length: 240 }, (_, index) => `片段${index} `);
    f.http.setNextReplyStream(chunks, { pauseAfter: 120 });

    await startThreadFromSurface(f.page, { prompt: "Stream a long answer" });

    const reply = f.page.locator(".timeline-item--assistant").last().locator(".message__content");
    const firstHalf = chunks.slice(0, 120).join("").trim();
    // Mid-stream (the fixture holds the rest), the first half is on screen
    // exactly once while the run is still active.
    await expect(reply).toHaveText(firstHalf, { timeout: 15_000 });
    await expect(f.page.getByTestId("send")).toHaveAttribute("aria-label", "Stop run");
    // Outlive the one-per-second mid-message snapshot so one races the held stream.
    await f.page.waitForTimeout(1_500);
    await expect(reply).toHaveText(firstHalf);

    f.http.release();

    await expect(reply).toHaveText(chunks.join("").trim(), { timeout: 15_000 });
    await expect(f.page.getByTestId("send")).toHaveAttribute("aria-label", "Send message", { timeout: 15_000 });
    await expect(f.page.locator(".timeline-item--assistant")).toHaveCount(1);
  } finally {
    await f.close();
  }
});
