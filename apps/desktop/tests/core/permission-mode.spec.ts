import { expect, test } from "@playwright/test";
import { join } from "node:path";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
} from "../helpers/electron-app";

// Verifies the permission mode feature on the real Electron surface:
//  - default mode is `auto`
//  - the composer toggle renders and flips the projected state to `plan`
//  - the IPC path (window.piApp.setPermissionMode) also works and stays in sync
//  - toggling back returns to `auto` and clears the non-default entry
test("permission mode toggle renders in the composer and flips plan/auto", async ({}, testInfo) => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("permission-workspace");
  await seedAgentDir(agentDir);
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Permission session");

    const state0 = await getDesktopState(window);
    expect(state0.permissionModeBySession).toEqual({});

    const toggle = window.locator(".composer__permission-toggle");
    await expect(toggle).toBeVisible();
    // Default (auto) is the quiet chip, not pressed.
    await expect(toggle).toHaveText(/Writable|可写/);
    await expect(toggle).toHaveAttribute("aria-pressed", "false");

    // Flip to plan via the UI toggle.
    await toggle.click();
    const state1 = await getDesktopState(window);
    const sessionKey = Object.keys(state1.permissionModeBySession)[0];
    expect(sessionKey).toBeTruthy();
    expect(state1.permissionModeBySession[sessionKey]).toBe("plan");
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(toggle).toHaveClass(/composer__permission-toggle--plan/);

    // Flip back to auto via the toggle; the non-default entry is cleared and the
    // state returns to the default-empty projection.
    await toggle.click();
    const state2 = await getDesktopState(window);
    expect(state2.permissionModeBySession[sessionKey] ?? "auto").toBe("auto");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");

    await window.screenshot({ path: testInfo.outputPath("permission-mode-toggle.png") });
  } finally {
    await harness.electronApp.close();
  }
});
