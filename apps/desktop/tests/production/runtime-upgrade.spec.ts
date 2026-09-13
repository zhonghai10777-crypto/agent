import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { createNamedThread, getDesktopState, launchDesktop, makeUserDataDir, makeWorkspace, setDeferredThreadTitleMode, startThreadFromSurface, triggerApplicationMenuItem } from "../helpers/electron-app";
import { seedVisionAgentDir, startVisionHttpFixture, VISION_TEST_KEY } from "../helpers/vision-fixture";

test("legacy Electron encrypted credentials survive the runtime upgrade and isolated windows retain independent drafts", async ({}, info) => {
  const legacyExecutable = process.env.PI_APP_TEST_OLD_ELECTRON;
  test.skip(!legacyExecutable, "Explicit test-owned legacy Electron executable required.");
  test.setTimeout(120_000);
  const userData = await makeUserDataDir("runtime-upgrade-synthetic-");
  const agentDir = join(userData, "agent"), workspace = await makeWorkspace("runtime-upgrade");
  await seedVisionAgentDir(agentDir);
  const http = await startVisionHttpFixture();
  const options = { agentDir, initialWorkspaces: [workspace], scrubProviderEnv: true, testMode: "background" as const };
  let harness = await launchDesktop(userData, { ...options, runtimeExecutable: legacyExecutable });
  try {
    const oldVersion = await harness.electronApp.evaluate(() => process.versions.electron);
    expect(oldVersion).toBe("37.10.3");
    await http.install(harness);
    let page = await harness.firstWindow();
    await setDeferredThreadTitleMode(harness);
    await startThreadFromSurface(page, { prompt: "Synthetic credential before runtime upgrade" });
    await expect(page.locator(".timeline-item--assistant")).toContainText("Primary answer");
    await page.getByTestId("composer").fill("Retained draft from Electron 37");
    await expect.poll(async () => (await getDesktopState(page)).composerDraft).toBe("Retained draft from Electron 37");
    const ref = await getDesktopState(page);
    expect(await harness.electronApp.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable())).toBe(true);
    const encrypted = await readFile(join(userData, "secure-keys.json"), "utf8");
    expect(encrypted).not.toContain(VISION_TEST_KEY);
    await harness.close();
    harness = await launchDesktop(userData, options);
    await http.install(harness);
    page = await harness.firstWindow();
    await setDeferredThreadTitleMode(harness);
    const runtime = await harness.electronApp.evaluate(({ BrowserWindow }) => ({
      electron: process.versions.electron, node: process.versions.node,
      preferences: BrowserWindow.getAllWindows().map((window) => {
        const prefs = window.webContents.getLastWebPreferences();
        return { sandbox: prefs.sandbox, contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration };
      }),
    }));
    expect(runtime.electron).toBe("44.3.0");
    expect(runtime.preferences).toEqual([{ sandbox: true, contextIsolation: true, nodeIntegration: false }]);
    expect(await page.evaluate(() => ({ require: typeof (window as any).require, process: typeof (window as any).process, bridge: typeof window.piApp.getState })))
      .toEqual({ require: "undefined", process: "undefined", bridge: "function" });
    expect((await getDesktopState(page)).selectedSessionId).toBe(ref.selectedSessionId);
    await expect(page.getByTestId("composer")).toHaveValue("Retained draft from Electron 37");
    expect(await readFile(join(userData, "secure-keys.json"), "utf8")).toBe(encrypted);
    await page.getByTestId("send").click();
    await expect(page.locator(".timeline-item--assistant")).toHaveCount(2);
    expect(http.requests.filter((request) => request.kind === "primary")).toHaveLength(2);

    await createNamedThread(page, "First isolated thread");
    await page.getByTestId("composer").fill("First window draft");
    expect(await triggerApplicationMenuItem(harness, "file.new-window")).toBe(true);
    await expect.poll(() => harness.electronApp.windows().length).toBe(2);
    const second = harness.electronApp.windows().find((window) => window !== page)!;
    await createNamedThread(second, "Second isolated thread");
    await second.getByTestId("composer").fill("Second window draft");
    await expect(page.getByTestId("composer")).toHaveValue("First window draft");
    await expect(second.getByTestId("composer")).toHaveValue("Second window draft");
    await page.screenshot({ path: info.outputPath("runtime-upgrade.png") });
    await writeFile(info.outputPath("runtime-upgrade.json"), JSON.stringify({ legacyElectron: oldVersion, current: runtime, syntheticCredentials: true, fixtureRequests: http.requests.length }, null, 2));
  } finally { await harness.close(); await http.close(); }
});
