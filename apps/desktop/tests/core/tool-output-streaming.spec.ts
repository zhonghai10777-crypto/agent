import { expect, test } from "@playwright/test";
import { getDesktopState, startThreadFromSurface } from "../helpers/electron-app";
import { launchWithCompactionFixture } from "../helpers/compaction-fixture";

// pi reports a running command's output every 100ms. Those reports used to
// carry no text (pi sends content blocks, not a string), the tool row showed no
// output until the command ended, and each report still republished the whole
// app state and transcript. Now the row shows the latest output as it arrives,
// and only that row is patched into the window's transcript.
test("shows a running command's latest output on its row, patching only that row per report", async () => {
  test.skip(process.platform === "win32", "Uses a POSIX shell loop.");
  const f = await launchWithCompactionFixture("tool-output-stream");
  try {
    f.http.setNextUsage({ prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 });
    f.http.setNextToolCall("bash", { command: "for i in $(seq 1 40); do echo tick-$i; sleep 0.1; done" });
    f.http.setNextReplyText("All ticks printed.");
    // Count the whole-transcript pushes this window receives while the command runs.
    await f.page.evaluate(() => {
      const counters = window as unknown as { __transcriptPushes?: number };
      counters.__transcriptPushes = 0;
      window.piApp!.onSelectedTranscriptChanged(() => {
        counters.__transcriptPushes = (counters.__transcriptPushes ?? 0) + 1;
      });
    });
    const transcriptPushes = () =>
      f.page.evaluate(() => (window as unknown as { __transcriptPushes?: number }).__transcriptPushes ?? 0);
    const runningOutput = f.page.locator(".timeline-tool--running .timeline-tool__detail");

    await startThreadFromSurface(f.page, { prompt: "Print ticks" });
    // The latest output shows on the running tool's row while the command runs.
    await expect(runningOutput).toContainText("tick-3", { timeout: 15_000 });
    const revisionMidRun = (await getDesktopState(f.page)).revision;
    const pushesMidRun = await transcriptPushes();
    await expect(runningOutput).toContainText("tick-20", { timeout: 15_000 });
    await expect(f.page.getByTestId("send")).toHaveAttribute("aria-label", "Stop run");
    // Neither the app state nor the whole transcript was republished per report
    // (the state moved 36 times here when every report republished it); only
    // the tool row was patched.
    expect((await getDesktopState(f.page)).revision - revisionMidRun).toBeLessThanOrEqual(2);
    expect((await transcriptPushes()) - pushesMidRun).toBeLessThanOrEqual(2);

    await expect(f.page.getByTestId("send")).toHaveAttribute("aria-label", "Send message", { timeout: 15_000 });
    await expect(runningOutput).toHaveCount(0);
  } finally {
    await f.close();
  }
});
