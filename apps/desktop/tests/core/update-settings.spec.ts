import { expect, test } from "@playwright/test";
import { createNamedThread, launchDesktop, makeUserDataDir, makeWorkspace } from "../helpers/electron-app";

test("Windows settings distinguish update access, network, current and available states", async ({}, testInfo) => {
  const harness = await launchDesktop(await makeUserDataDir("update-settings-"), {
    initialWorkspaces: [await makeWorkspace("update-settings-workspace")],
    testMode: "background",
    envOverrides: { PI_APP_UPDATE_REPOSITORY: "publisher/agent-releases", PI_APP_UPDATE_TOKEN: "" },
  });
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Update settings session");
    await window.getByRole("button", { name: "Settings", exact: true }).click();
    await window.getByRole("button", { name: "General", exact: true }).click();
    const button = window.getByRole("button", { name: "Check for updates", exact: true });
    const status = window.getByTestId("update-check-status");
    await expect(button).toBeVisible();

    // Stub only the network boundary; the real button, preload, IPC and main
    // update checker run in Electron. No external repository or auth is needed.
    for (const scenario of ["access", "network", "current", "available"] as const) {
      await harness.electronApp.evaluate(({ net, app }, kind) => {
        const globals = globalThis as typeof globalThis & { __repairUpdateRequest?: { url: string; authenticated: boolean } };
        net.fetch = async (url, init) => {
          globals.__repairUpdateRequest = { url: String(url), authenticated: new Headers(init?.headers).has("Authorization") };
          if (kind === "network") throw new Error("offline test");
          if (kind === "access") return new Response("{}", { status: 404 });
          return new Response(JSON.stringify([{ tag_name: kind === "current" ? `v${app.getVersion()}` : "v99.0.0" }]));
        };
      }, scenario);
      await button.click();
      if (scenario === "access") await expect(status).toContainText("requires access");
      if (scenario === "network") await expect(status).toContainText("Check your connection");
      if (scenario === "current") await expect(status).toContainText("up to date");
      if (scenario === "available") {
        await expect(status).toContainText("99.0.0");
        await expect(window.getByRole("link", { name: "View download" })).toHaveAttribute(
          "href", "https://github.com/publisher/agent-releases/releases/tag/v99.0.0",
        );
      }
      await expect(button).toBeEnabled();
      expect(await harness.electronApp.evaluate(() => (globalThis as typeof globalThis & {
        __repairUpdateRequest?: { url: string; authenticated: boolean };
      }).__repairUpdateRequest)).toEqual({
        url: "https://api.github.com/repos/publisher/agent-releases/releases?per_page=10", authenticated: false,
      });
      await window.screenshot({ path: testInfo.outputPath(`update-${scenario}.png`) });
    }
    await window.getByRole("button", { name: "简体中文", exact: true }).click();
    await expect(window.getByRole("button", { name: "检查更新", exact: true })).toBeVisible();
    await expect(status).toContainText("发现新版本");
    await window.screenshot({ path: testInfo.outputPath("update-chinese.png") });
  } finally {
    await harness.close();
  }
});
