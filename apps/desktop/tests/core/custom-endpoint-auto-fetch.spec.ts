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
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "auto-model-a" }, { id: "auto-model-b" }] }));
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

test("saving a custom endpoint with no models auto-fetches from /models", async () => {
  test.setTimeout(60_000);
  const { server, port } = await startModelsServer();
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("auto-fetch-workspace");
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
    await dialog.getByLabel("Provider ID").fill("auto-endpoint");
    await dialog.getByLabel("Base URL").fill(`http://127.0.0.1:${port}/v1`);
    await dialog.getByRole("button", { name: "Add endpoint", exact: true }).click();
    await expect(dialog).toHaveCount(0);

    // Auto-fetched models appear.
    await window.getByRole("button", { name: "Models", exact: true }).click();
    await expect(window.locator(".view-header__title")).toHaveText("Models");
    const enabledModels = window.locator(".settings-section", {
      has: window.locator(".settings-section__title", { hasText: "Enabled models" }),
    });
    await expect(enabledModels).toContainText("auto-endpoint/auto-model-a");
    await expect(enabledModels).toContainText("auto-endpoint/auto-model-b");
  } finally {
    await harness.close();
    server.close();
  }
});
