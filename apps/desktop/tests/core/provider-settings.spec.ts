import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  desktopShortcut,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  stubNextOpenDialog,
} from "../helpers/electron-app";

test("settings lets the user add a custom endpoint and its models become available", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("provider-settings-api-key-workspace");
  await seedAgentDir(agentDir, {
    withOpenAiAuth: false,
    withDefaultModel: false,
    withCustomProvider: false,
    enabledModels: [],
  });

  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await window.keyboard.press(desktopShortcut(","));
    await expect(window.getByTestId("settings-surface")).toBeVisible();
    await window.getByRole("button", { name: "Providers", exact: true }).click();
    await expect(window.locator(".view-header__title")).toHaveText("Providers");

    const customEndpoints = window.locator(".settings-section", {
      has: window.locator(".settings-section__title", { hasText: "Custom endpoints" }),
    });
    await expect(customEndpoints).toContainText("No custom endpoints yet.");
    await customEndpoints.getByRole("button", { name: "Add endpoint", exact: true }).click();

    const dialog = window.getByTestId("custom-endpoint-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Provider ID").fill("my-endpoint");
    await dialog.getByLabel("Base URL").fill("http://localhost:11434/v1");
    await dialog.getByLabel("API key").fill("test-key");
    await dialog.getByLabel("Add model ID manually").fill("my-model");
    await dialog.getByRole("button", { name: "Add", exact: true }).click();
    await dialog.getByRole("button", { name: "Add endpoint", exact: true }).click();
    await expect(dialog).toHaveCount(0);

    const connectedProviders = window.locator(".settings-section", {
      has: window.locator(".settings-section__title", { hasText: "Connected" }),
    });
    await expect(connectedProviders).toContainText("my-endpoint");

    await window.getByRole("button", { name: "Models", exact: true }).click();
    const enabledModels = window.locator(".settings-section", {
      has: window.locator(".settings-section__title", { hasText: "Enabled models" }),
    });
    await expect(enabledModels).toContainText("my-endpoint/my-model");
  } finally {
    await harness.close();
  }
});

test("opening the first workspace from the empty state hydrates provider and model settings without refresh", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("provider-settings-first-workspace");
  await seedAgentDir(agentDir, {
    enabledModels: ["test-openai/gpt-5", "test-openai/gpt-4o"],
  });

  const harness = await launchDesktop(userDataDir, {
    agentDir,
    scrubProviderEnv: true,
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await stubNextOpenDialog(harness, [workspacePath]);
    // The app now always exposes the personal workspace, so the folder picker
    // is opened from the sidebar action instead of a global empty state.
    await window.getByLabel("Open folder", { exact: true }).click();

    await expect(window.getByTestId("empty-state")).toHaveCount(0);
    await expect(window.getByTestId("workspace-list")).toContainText("provider-settings-first-workspace");
    await expect(window.getByTestId("new-thread-composer")).toBeVisible();

    await window.keyboard.press(desktopShortcut(","));
    const settingsSurface = window.getByTestId("settings-surface");
    await expect(settingsSurface).toBeVisible();
    await expect(settingsSurface.getByRole("button", { name: "Refresh", exact: true })).toHaveCount(0);

    await window.getByRole("button", { name: "Providers", exact: true }).click();
    await expect(window.locator(".view-header__title")).toHaveText("Providers");

    const connectedProviders = window.locator(".settings-section", {
      has: window.locator(".settings-section__title", { hasText: "Connected" }),
    });
    await expect(connectedProviders).toContainText("test-openai");

    await window.getByRole("button", { name: "Models", exact: true }).click();
    await expect(window.locator(".view-header__title")).toHaveText("Models");

    const enabledModels = window.locator(".settings-section", {
      has: window.locator(".settings-section__title", { hasText: "Enabled models" }),
    });
    await expect(enabledModels).toContainText("test-openai/gpt-5");
    await expect(enabledModels).toContainText("test-openai/gpt-4o");
  } finally {
    await harness.close();
  }
});
