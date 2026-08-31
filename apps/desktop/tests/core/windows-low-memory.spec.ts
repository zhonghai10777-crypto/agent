import { expect, test } from "@playwright/test";
import {
  createSessionViaIpc,
  emitTestSessionEvent,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedTranscriptMessages,
} from "../helpers/electron-app";

test("keeps long transcripts virtualized and streams through delta-only IPC", async () => {
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("windows-low-memory");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createSessionViaIpc(window, workspacePath, "Low-memory transcript");
    await seedTranscriptMessages(harness, window, {
      count: 85,
      textFactory: (index) => index === 12 ? `oversized row ${"x".repeat(5_000)}` : `history row ${index}`,
    });

    await expect(window.locator(".timeline--virtualized")).toBeVisible();
    const mountedRows = await window.locator(".timeline-item").count();
    expect(mountedRows).toBeLessThan(80);

    const state = await getDesktopState(window);
    const workspace = state.workspaces.find((entry) => entry.id === state.selectedWorkspaceId);
    const session = workspace?.sessions.find((entry) => entry.id === state.selectedSessionId);
    expect(workspace).toBeDefined();
    expect(session).toBeDefined();
    if (!workspace || !session) return;

    const sessionRef = { workspaceId: workspace.id, sessionId: session.id };
    const startedAt = new Date().toISOString();
    await emitTestSessionEvent(harness, {
      type: "sessionUpdated",
      sessionRef,
      timestamp: startedAt,
      runId: "delta-only-run",
      snapshot: {
        ref: sessionRef,
        workspace: { workspaceId: workspace.id, path: workspace.path, displayName: workspace.name },
        title: session.title,
        status: "running",
        updatedAt: startedAt,
        preview: "delta stream",
        runningRunId: "delta-only-run",
      },
    });
    await window.waitForTimeout(250);

    await window.evaluate(() => {
      const api = window.piApp;
      if (!api) throw new Error("Desktop API unavailable");
      const counts = { state: 0, transcript: 0, delta: 0 };
      const unsubscribe = [
        api.onStateChanged(() => { counts.state += 1; }),
        api.onSelectedTranscriptChanged(() => { counts.transcript += 1; }),
        api.onAssistantDelta(() => { counts.delta += 1; }),
      ];
      Object.assign(window, {
        __lowMemoryIpcProbe: {
          counts,
          stop: () => unsubscribe.forEach((callback) => callback()),
        },
      });
    });

    for (let index = 0; index < 20; index += 1) {
      await emitTestSessionEvent(harness, {
        type: "assistantDelta",
        sessionRef,
        timestamp: new Date(Date.now() + index).toISOString(),
        runId: "delta-only-run",
        text: `chunk-${index} `,
      });
    }

    await expect(window.getByTestId("transcript")).toContainText("chunk-19");
    await expect.poll(() => window.evaluate(() => {
      const probe = (window as typeof window & {
        __lowMemoryIpcProbe?: { counts: { state: number; transcript: number; delta: number } };
      }).__lowMemoryIpcProbe;
      return probe?.counts;
    })).toMatchObject({ state: 0, transcript: 0, delta: expect.any(Number) });
    const deltaCount = await window.evaluate(() => (
      window as typeof window & { __lowMemoryIpcProbe?: { counts: { delta: number } } }
    ).__lowMemoryIpcProbe?.counts.delta ?? 0);
    expect(deltaCount).toBeGreaterThan(0);

    await window.evaluate(() => {
      const probe = (window as typeof window & { __lowMemoryIpcProbe?: { stop: () => void } }).__lowMemoryIpcProbe;
      probe?.stop();
      delete (window as typeof window & { __lowMemoryIpcProbe?: unknown }).__lowMemoryIpcProbe;
    });
  } finally {
    await harness.close();
  }
});
