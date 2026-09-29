import { expect, test } from "@playwright/test";
import { startThreadFromSurface, type DesktopHarness } from "../helpers/electron-app";
import { launchWithCompactionFixture } from "../helpers/compaction-fixture";

interface QuitConfirmationHooks {
  answerQuitConfirmation(answer: boolean): void;
  quitConfirmationPrompts(): number[];
}

async function answerQuitConfirmation(harness: DesktopHarness, answer: boolean): Promise<void> {
  await harness.electronApp.evaluate((_electron, value) => {
    (globalThis as unknown as { __PI_APP_TEST_HOOKS: QuitConfirmationHooks }).__PI_APP_TEST_HOOKS.answerQuitConfirmation(value);
  }, answer);
}

async function quitConfirmationPrompts(harness: DesktopHarness): Promise<number[]> {
  return harness.electronApp.evaluate(() =>
    (globalThis as unknown as { __PI_APP_TEST_HOOKS: QuitConfirmationHooks }).__PI_APP_TEST_HOOKS.quitConfirmationPrompts(),
  );
}

// Quitting aborts running tasks. On Windows closing the last window quits the
// app (test mode quits that way on every platform), so that close has to ask
// before the window is gone, and so does a direct quit such as Cmd+Q.
test("quitting with a task running asks first, and cancelling keeps the app and the task", async () => {
  const f = await launchWithCompactionFixture("quit-confirm");
  try {
    f.http.setNextUsage({ prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 });
    f.http.setNextReplyStream(["still ", "working"], { pauseAfter: 1 });
    await startThreadFromSurface(f.page, { prompt: "Keep working" });
    const send = f.page.getByTestId("send");
    await expect(send).toHaveAttribute("aria-label", "Stop run", { timeout: 15_000 });

    await answerQuitConfirmation(f.harness, false);
    await f.harness.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    await expect.poll(() => quitConfirmationPrompts(f.harness)).toEqual([1]);
    await f.harness.electronApp.evaluate(({ app }) => app.quit());
    await expect.poll(() => quitConfirmationPrompts(f.harness)).toEqual([1, 1]);
    expect(await f.harness.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    await expect(send).toHaveAttribute("aria-label", "Stop run");

    await answerQuitConfirmation(f.harness, true);
    const exited = new Promise((resolve) => f.harness.electronApp.process().once("exit", resolve));
    await f.harness.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    await exited;
  } finally {
    f.http.release();
    await f.close();
  }
});
