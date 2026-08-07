import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  desktopShortcut,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

async function startModelsServer(): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/v1/models")) {
      const models = Array.from({ length: 40 }, (_, i) => ({ id: `model-${i}` }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: models }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { server, port };
}

test("dialog with many detected models keeps the action buttons reachable", async () => {
  test.setTimeout(60_000);
  const { server, port } = await startModelsServer();
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("dialog-scroll-workspace");
  await seedAgentDir(agentDir, { enabledModels: [], withCustomProvider: false });

  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await window.keyboard.press(desktopShortcut(","));
    await expect(window.getByTestId("settings-surface")).toBeVisible();
    await window.getByRole("button", { name: "Providers", exact: true }).click();

    const customEndpoints = window.locator(".settings-section", {
      has: window.locator(".settings-section__title", { hasText: "Custom endpoints" }),
    });
    await customEndpoints.getByRole("button", { name: "Add endpoint", exact: true }).click();

    const dialog = window.getByTestId("custom-endpoint-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Provider ID").fill("scroll-test");
    await dialog.getByLabel("Base URL").fill(`http://127.0.0.1:${port}/v1`);

    // Detect models -> fills the checklist with 40 models.
    await dialog.getByRole("button", { name: "Detect models", exact: true }).click();
    await expect(dialog.locator(".settings-list")).toContainText("model-39");

    // The model list must be internally scrollable (not overflow the dialog).
    const list = dialog.locator(".settings-list");
    await expect(list).toHaveCSS("max-height", "240px");
    await expect(list).toHaveCSS("overflow-y", "auto");

    // The Add endpoint button must be visible in the dialog (scrolled into view).
    const addButton = dialog.getByRole("button", { name: "Add endpoint", exact: true });
    await expect(addButton).toBeVisible();
    await addButton.scrollIntoViewIfNeeded();
    await expect(addButton).toBeEnabled();
  } finally {
    await harness.close();
    server.close();
  }
});
