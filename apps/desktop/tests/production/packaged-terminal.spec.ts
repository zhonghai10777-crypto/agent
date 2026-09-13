import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  desktopShortcut,
  launchPackagedDesktop,
  makeUserDataDir,
  makeWorkspace,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

test("packaged app opens a real integrated terminal", async () => {
  test.setTimeout(60_000);

  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("packaged-terminal");
  const harness = await launchPackagedDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await createNamedThread(window, "Packaged terminal thread");

    await window.keyboard.press(desktopShortcut("J"));
    const terminal = window.getByTestId("integrated-terminal");
    await expect(terminal).toBeVisible();
    await terminal.locator(".xterm").click();
    await window.keyboard.type("echo PI_PACKAGED_TERMINAL_OK");
    await window.keyboard.press("Enter");
    await expect(terminal.locator(".xterm-rows > div").filter({ hasText: /^PI_PACKAGED_TERMINAL_OK\s*$/ })).toHaveCount(1, { timeout: 15_000 });
    await window.keyboard.type("exit");
    await window.keyboard.press("Enter");
    await expect(terminal.locator(".terminal-panel__status--exited")).toHaveCount(1);
  } finally {
    await harness.close();
  }
});
