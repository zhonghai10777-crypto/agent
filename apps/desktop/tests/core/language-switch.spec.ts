import { expect, test } from "@playwright/test";
import {
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

/**
 * Verifies the locale switch works end-to-end:
 *  1. Default locale is English (state.locale === "en").
 *  2. Switching to Simplified Chinese in Settings → General updates state,
 *     persists to ui-state.json, and flips visible UI strings to Chinese.
 *  3. Relaunching restores the Chinese locale (persistence).
 */
test("switches the interface language to Simplified Chinese and persists it", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("language-switch-workspace");

  // First run: switch the locale to Simplified Chinese.
  const firstRun = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await firstRun.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);

    // Test launches force an English default via PI_APP_DEFAULT_LOCALE=env; production default is zh-CN.
    expect((await getDesktopState(window)).locale).toBe("en");
    const sidebar = window.getByRole("complementary");
    await expect(sidebar.getByRole("button", { name: "New thread", exact: true })).toBeVisible();

    // Navigate to Settings → General.
    await window.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(window.locator(".settings-view")).toBeVisible();
    await window.getByRole("button", { name: "General", exact: true }).click();

    // Switch to Simplified Chinese.
    await window.getByRole("button", { name: "简体中文", exact: true }).click();
    await expect.poll(async () => (await getDesktopState(window)).locale).toBe("zh-CN");

    // Visible UI strings flip to Chinese (including the settings back button).
    await window.getByRole("button", { name: "返回应用", exact: true }).click();
    await expect(sidebar.getByRole("button", { name: "新建线程", exact: true })).toBeVisible();
  } finally {
    // Release the single-instance lock before relaunching on the same user data dir.
    await firstRun.close();
  }

  // Persistence: relaunch and confirm the locale survived.
  const secondRun = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const secondWindow = await secondRun.firstWindow();
    await waitForWorkspaceByPath(secondWindow, workspacePath);
    await expect.poll(async () => (await getDesktopState(secondWindow)).locale).toBe("zh-CN");
    await expect(
      secondWindow.getByRole("complementary").getByRole("button", { name: "新建线程", exact: true }),
    ).toBeVisible();
  } finally {
    await secondRun.close();
  }
});
