import { readFile, realpath, writeFile } from "node:fs/promises";
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
    expect(state.capabilities).toMatchObject({
      terminal: false,
      worktrees: false,
      fileMutation: false,
      officeMutation: true,
      shellExecution: false,
      childAgents: false,
      extensions: false,
    });
    await expect(window.getByLabel("Toggle terminal")).toHaveCount(0);
    await expect(window.getByRole("button", { name: "Skills", exact: true })).toHaveCount(0);
    await expect(window.getByRole("button", { name: "Extensions", exact: true })).toHaveCount(0);
    await expect(window.getByRole("button", { name: "Worktree", exact: true })).toHaveCount(0);
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
    await expect(window.getByLabel("Shell of integrated terminal")).toHaveCount(0);
    await expect.poll(async () => {
      const persisted = JSON.parse(await readFile(join(userDataDir, "ui-state.json"), "utf8")) as { runtimeMode?: string };
      return persisted.runtimeMode;
    }).toBe("agent");
  } finally {
    await first.close();
  }
});

test("light mode starts a chat in the app-managed personal workspace without opening a folder", async () => {
  const userDataDir = await makeUserDataDir();
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [],
    testMode: "background",
    envOverrides: { PI_APP_DEFAULT_RUNTIME_MODE: "light" },
  });
  try {
    const window = await harness.firstWindow();
    const state = await getDesktopState(window);
    const personalWorkspace = state.workspaces.find((workspace) => workspace.kind === "personal");
    const expectedPersonalPath = await realpath(join(userDataDir, "personal-workspace"));
    expect(personalWorkspace).toMatchObject({
      path: expectedPersonalPath,
      managed: true,
    });
    await expect(window.getByTestId("new-thread-composer")).toBeVisible();
    await window.getByTestId("new-thread-composer").fill("普通聊天，不需要先选择文件夹");
    await window.getByRole("button", { name: "Start thread" }).click();
    await expect(window.getByTestId("composer")).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => (await getDesktopState(window)).selectedWorkspaceId).toBe(personalWorkspace?.id);
  } finally {
    await harness.close();
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
