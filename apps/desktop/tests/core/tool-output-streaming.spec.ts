import { expect, test } from "@playwright/test";
import { getDesktopState, startThreadFromSurface } from "../helpers/electron-app";
import { launchWithCompactionFixture } from "../helpers/compaction-fixture";

// pi reports a running command's output every 100ms. Those reports used to
// carry no text (pi sends content blocks, not a string), so the output only
// appeared when the command ended, and each one still recomputed and
// republished the whole app state. Now the latest output streams in and only
// the transcript of the session that changed is pushed.
test("streams a running command's output to the window without republishing app state per report", async () => {
  test.skip(process.platform === "win32", "Uses a POSIX shell loop.");
  const f = await launchWithCompactionFixture("tool-output-stream");
  try {
    f.http.setNextUsage({ prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 });
    f.http.setNextToolCall("bash", { command: "for i in $(seq 1 40); do echo tick-$i; sleep 0.1; done" });
    f.http.setNextReplyText("All ticks printed.");
    // What the main process pushes to this window, as the renderer receives it.
    await f.page.evaluate(() => {
      const pushed = window as unknown as { __latestToolDetail?: string };
      window.piApp!.onSelectedTranscriptChanged((record) => {
        const tool = record?.transcript.findLast((item) => item.kind === "tool");
        if (tool?.kind === "tool") pushed.__latestToolDetail = tool.detail ?? "";
      });
    });
    const pushedDetail = () =>
      f.page.evaluate(() => (window as unknown as { __latestToolDetail?: string }).__latestToolDetail ?? "");

    await startThreadFromSurface(f.page, { prompt: "Print ticks" });
    await expect.poll(pushedDetail, { timeout: 15_000 }).toContain("tick-3");
    const revisionMidRun = (await getDesktopState(f.page)).revision;
    await expect.poll(pushedDetail, { timeout: 15_000 }).toContain("tick-20");
    // The command is still running and its output keeps arriving, but the app
    // state has not been republished for it (it was once per report).
    await expect(f.page.getByTestId("send")).toHaveAttribute("aria-label", "Stop run");
    expect((await getDesktopState(f.page)).revision - revisionMidRun).toBeLessThanOrEqual(2);

    await expect(f.page.getByTestId("send")).toHaveAttribute("aria-label", "Send message", { timeout: 15_000 });
  } finally {
    await f.close();
  }
});
