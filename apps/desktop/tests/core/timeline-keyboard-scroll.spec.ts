import { expect, test } from "@playwright/test";
import {
  createSessionViaIpc,
  getTimelineScrollMetrics,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedTranscriptMessages,
  selectSession,
} from "../helpers/electron-app";

test("PageUp scrolls the timeline up without snapping back to the bottom", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("timeline-keyboard-scroll");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    const title = "Keyboard scroll test";
    await createSessionViaIpc(window, workspacePath, title);
    await selectSession(window, title);

    await seedTranscriptMessages(harness, window, {
      count: 300,
      textFactory: (index) => `Row ${index} content line. `.repeat(8),
    });

    // Settle at the bottom before scrolling up.
    await expect.poll(async () => (await getTimelineScrollMetrics(window)).remainingFromBottom).toBeLessThanOrEqual(16);

    // tabIndex on the pane (this change) is what makes it a legitimate keyboard-navigation
    // target — this simulates a user tabbing to the transcript rather than clicking a row.
    await window.evaluate(() => {
      document.querySelector<HTMLDivElement>("[data-testid='timeline-pane']")?.focus();
    });

    const before = await getTimelineScrollMetrics(window);
    await window.keyboard.press("PageUp");
    // Give the bottom-pinning engine's own realignment logic (rAF-driven) a chance to run
    // and (incorrectly, pre-fix) snap the scroll position back.
    await window.waitForTimeout(600);
    const after = await getTimelineScrollMetrics(window);

    expect(after.scrollTop).toBeLessThan(before.scrollTop - 100);
  } finally {
    await harness.close();
  }
});
