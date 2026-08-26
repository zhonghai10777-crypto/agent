import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchDesktop, makeUserDataDir, makeWorkspace, getDesktopState } from "../helpers/electron-app";

test("defaults to light mode, persists the selection, and reports restart requirement", async () => {
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("runtime-mode");
  const first = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
    envOverrides: { PI_APP_DEFAULT_RUNTIME_MODE: "light" },
  });
  try {
    const window = await first.firstWindow();
    await expect.poll(async () => (await getDesktopState(window)).runtimeMode).toBe("light");
    const state = await getDesktopState(window);
    expect(state.activeRuntimeMode).toBe("light");
    await expect(window.evaluate(async () => {
      try {
        await window.piApp?.ensureTerminalPanel("missing", "missing");
        return "allowed";
      } catch (error) {
        return String(error);
      }
    })).resolves.toContain("unavailable in light mode");
    await window.keyboard.press("Control+,");
    await expect(window.getByTestId("settings-surface")).toBeVisible();
    await window.getByRole("button", { name: "General", exact: true }).click();
    await expect(window.getByRole("button", { name: "Agent mode", exact: true })).toBeVisible();
    await window.getByRole("button", { name: "Agent mode", exact: true }).click();
    await expect(window.getByText("A different mode is selected. Restart the app to apply it.")).toBeVisible();
    await expect.poll(async () => {
      const persisted = JSON.parse(await readFile(join(userDataDir, "ui-state.json"), "utf8")) as { runtimeMode?: string };
      return persisted.runtimeMode;
    }).toBe("agent");
  } finally {
    await first.close();
  }
});

test("restores agent mode after relaunch", async () => {
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("runtime-mode-agent");
  await writeFile(join(userDataDir, "ui-state.json"), JSON.stringify({ runtimeMode: "agent" }));
  const harness = await launchDesktop(userDataDir, { initialWorkspaces: [workspacePath], testMode: "background" });
  try {
    const window = await harness.firstWindow();
    await expect.poll(async () => (await getDesktopState(window)).activeRuntimeMode).toBe("agent");
  } finally {
    await harness.close();
  }
});
