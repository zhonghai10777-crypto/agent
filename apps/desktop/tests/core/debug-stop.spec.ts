import { expect, test } from "@playwright/test";
import {
  createSessionViaIpc,
  emitTestSessionEvent,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

/**
 * Debug: does stopping actually return a running session to idle in the real
 * app? Creates a real session, emits a "running" snapshot (no completion), then
 * invokes cancelCurrentRun through the app's IPC interface (the same handler the
 * Stop button calls) and asserts the session returns to idle.
 */
test("debug: stop button returns a running session to idle", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir("debug-stop-");
  const workspacePath = await makeWorkspace("debug-stop-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);

    // Create a real session via IPC. An idle session (no real prompt sent) keeps
    // the runtime quiet, so the synthetic "running" snapshot below is not
    // overwritten by a real send failure from an unreachable test provider.
    await createSessionViaIpc(window, workspacePath, "Debug stop thread");
    const composer = window.getByTestId("composer");
    await expect(composer).toBeVisible({ timeout: 15_000 });

    // Find the created session. New threads start with the placeholder title
    // ("New thread") until auto-title generation resolves, so locate it via the
    // selected session id instead of matching on title.
    const state = await getDesktopState(window);
    const workspace = state.workspaces.find((w) => w.id === state.selectedWorkspaceId);
    const session = workspace?.sessions.find((s) => s.id === state.selectedSessionId);
    expect(session, "session should be created").toBeTruthy();
    const sessionId = session!.id;
    const workspaceId = workspace!.id;

    // Emit a running snapshot so the Stop button appears.
    const timestamp = new Date().toISOString();
    await emitTestSessionEvent(harness, {
      type: "sessionUpdated",
      sessionRef: { workspaceId, sessionId },
      timestamp,
      runId: "debug-stop-run",
      snapshot: {
        ref: { workspaceId, sessionId },
        workspace: {
          workspaceId,
          path: workspacePath,
          displayName: "debug-stop-workspace",
        },
        title: "Debug stop thread",
        status: "running",
        updatedAt: timestamp,
        preview: "Working…",
        runningRunId: "debug-stop-run",
      },
    });

    // The Stop button should appear while the session is running.
    const stopButton = window.getByRole("button", { name: "Stop run" });
    await expect(stopButton).toBeVisible({ timeout: 10_000 });

    // Drive the stop through the app's IPC interface (the same handler the Stop
    // button invokes) rather than clicking the DOM, so this spec tests the
    // cancellation behavior and not Playwright's actionability checks.
    const stateAfterStop = await window.evaluate(async () => {
      const app = (window as PiAppWindow).piApp;
      if (!app) {
        throw new Error("piApp IPC bridge is unavailable");
      }
      return app.cancelCurrentRun();
    });
    expect(stateAfterStop).toBeTruthy();

    // Assert the session returns to idle: Send message button reappears.
    await expect(window.getByRole("button", { name: "Send message" })).toBeVisible({ timeout: 15_000 });

    const stateAfter = await getDesktopState(window);
    const sessionAfter = stateAfter.workspaces
      .flatMap((w) => w.sessions)
      .find((s) => s.id === sessionId);
    expect(sessionAfter?.status).toBe("idle");
  } finally {
    await harness.close();
  }
});
