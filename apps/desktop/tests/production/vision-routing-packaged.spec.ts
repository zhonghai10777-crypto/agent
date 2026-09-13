import { cp, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { getDesktopState, launchDesktopByExecutable, launchPackagedDesktop, makeUserDataDir, makeWorkspace, setDeferredThreadTitleMode, startThreadFromSurface } from "../helpers/electron-app";
import { pasteVisionImage, seedVisionAgentDir, startVisionHttpFixture } from "../helpers/vision-fixture";

test("packaged auxiliary vision preserves Pro, evidence, Stop, retry and reopen", async ({}, info) => {
  test.skip(process.env.PI_APP_TEST_PACKAGED_VISION !== "1", "Requires an explicit packaged vision run.");
  test.setTimeout(180_000);
  let executable: string | undefined;
  if (process.platform === "win32") {
    const sourceExecutable = resolve(process.env.PI_APP_TEST_VISION_EXE ?? "apps/desktop/release/win-unpacked/agent.exe");
    const installedDir = join(await makeUserDataDir("Agent-打包验证-"), "中文用户", "应用程序", "Agent");
    await mkdir(installedDir, { recursive: true });
    await cp(dirname(sourceExecutable), installedDir, { recursive: true });
    executable = join(installedDir, "agent.exe");
  }
  const userDataDir = await makeUserDataDir("Agent-中文用户-");
  const agentDir = join(userDataDir, "agent");
  const workspace = await makeWorkspace("视觉-中文工程");
  await seedVisionAgentDir(agentDir);
  const http = await startVisionHttpFixture();
  const options = { agentDir, initialWorkspaces: [workspace], scrubProviderEnv: true, testMode: "background" as const };
  const launch = () => executable ? launchDesktopByExecutable(executable, userDataDir, options) : launchPackagedDesktop(userDataDir, options);
  let harness = await launch();
  try {
    let page = await harness.firstWindow();
    if (executable) expect(await harness.electronApp.evaluate(() => process.execPath)).toBe(executable);
    expect(await harness.electronApp.evaluate(({ app }) => app.getAppPath())).toMatch(/\.asar$/);
    await http.install(harness);
    await setDeferredThreadTitleMode(harness);
    await startThreadFromSurface(page, { prompt: "Packaged text baseline" });
    await expect(page.locator(".timeline-item--assistant")).toContainText("Primary answer from deepseek-v4-pro");
    http.setVisionMode("hold");
    await pasteVisionImage(page);
    await page.getByTestId("composer").fill("Read the packaged test image");
    await page.getByTestId("send").click();
    await expect(page.getByTestId("vision-status")).toHaveAttribute("data-stage", "recognizing");
    await page.getByRole("button", { name: "Stop run" }).click();
    await expect(page.getByTestId("vision-status")).toHaveAttribute("data-stage", "cancelled");
    expect(http.requests.filter((request) => request.kind === "primary")).toHaveLength(1);
    http.setVisionMode("success");
    http.release();
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.getByTestId("vision-status")).toHaveAttribute("data-stage", "completed");
    await page.getByRole("button", { name: "View image evidence" }).click();
    await expect(page.getByTestId("vision-evidence")).toContainText("ERROR 42");
    await page.screenshot({ path: info.outputPath("packaged-vision.png"), fullPage: true });
    const state = await getDesktopState(page);
    expect(state.workspaces.flatMap((entry) => entry.sessions).find((entry) => entry.id === state.selectedSessionId)?.config?.modelId).toBe("deepseek-v4-pro");
    await harness.close();
    const count = http.requests.length;
    harness = await launch();
    page = await harness.firstWindow();
    await http.install(harness);
    await expect(page.locator(".timeline-item__attachment--image")).toHaveCount(1);
    await page.getByRole("button", { name: "View image evidence" }).click();
    await expect(page.getByTestId("vision-evidence")).toContainText("ERROR 42");
    expect(http.requests).toHaveLength(count);
    await page.screenshot({ path: info.outputPath("packaged-reopen.png"), fullPage: true });
  } finally { await harness.close().catch(() => {}); await http.close(); }
});
