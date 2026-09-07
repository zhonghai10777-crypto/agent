import { join } from "node:path";
import { access } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { desktopShortcut, getDesktopState, getSelectedTranscript, launchDesktop, makeUserDataDir, makeWorkspace, openNewThread, setDeferredThreadTitleMode, startThreadFromSurface, triggerApplicationMenuItem } from "../helpers/electron-app";
import { pasteVisionImage, seedVisionAgentDir, startVisionHttpFixture, VISION_PNG } from "../helpers/vision-fixture";

async function setup(options: { modelId?: string; blockImages?: boolean; light?: boolean } = {}) {
  const userDataDir = await makeUserDataDir("vision-用户-");
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("vision-工作区");
  await seedVisionAgentDir(agentDir, options);
  const http = await startVisionHttpFixture();
  const harness = await launchDesktop(userDataDir, { agentDir, initialWorkspaces: [workspacePath], scrubProviderEnv: true, testMode: "background", ...(options.light ? { envOverrides: { PI_APP_DEFAULT_RUNTIME_MODE: "light" } } : {}) });
  try {
    const page = await harness.firstWindow();
    await http.install(harness);
    await setDeferredThreadTitleMode(harness);
    if (options.light) {
      await openNewThread(page);
      await page.getByTestId("new-thread-composer").fill("TEXT_ONLY");
      await page.getByRole("button", { name: "Start thread", exact: true }).click();
    } else await startThreadFromSurface(page, { prompt: "TEXT_ONLY" });
    await expect(page.locator(".timeline-item--assistant")).toContainText(`Primary answer from ${options.modelId ?? "deepseek-v4-pro"}`);
    return { userDataDir, agentDir, workspacePath, http, harness, page };
  } catch (error) { await harness.close(); await http.close(); throw error; }
}

async function visionView(page: Page) {
  return page.evaluate(async () => {
    const state = await window.piApp!.getState();
    return window.piApp!.getVisionSession({ workspaceId: state.selectedWorkspaceId!, sessionId: state.selectedSessionId! });
  });
}

test("Flash routes image-only input; native images gain missing evidence only after a text-model send", async () => {
  const f = await setup({ modelId: "deepseek-v4-flash" });
  let reopened: typeof f.harness | undefined;
  try {
    await pasteVisionImage(f.page);
    await f.page.getByTestId("send").click();
    await expect(f.page.getByTestId("vision-status")).toHaveAttribute("data-stage", "completed");
    expect(f.http.requests.map((request) => request.kind)).toEqual(["primary", "vision", "primary"]);
    expect(f.http.requests[2]!.body.model).toBe("deepseek-v4-flash");
    expect(JSON.stringify(f.http.requests[2]!.body)).not.toContain(VISION_PNG);
    await f.page.locator(".model-selector__badge").filter({ hasText: "deepseek-v4-flash" }).click();
    await f.page.locator(".model-selector__item").filter({ hasText: "native-vision-fixture" }).click();
    await expect(f.page.locator(".model-selector__badge").first()).toContainText("native-vision-fixture");
    await pasteVisionImage(f.page);
    await f.page.getByTestId("send").click();
    await expect.poll(() => f.http.requests.length).toBe(4);
    expect(f.http.requests[3]!.body.model).toBe("native-vision-fixture");
    expect(JSON.stringify(f.http.requests[3]!.body)).toContain(VISION_PNG);
    expect(f.http.requests.filter((request) => request.kind === "vision")).toHaveLength(1);
    await expect(f.page.locator(".timeline-item--assistant").last()).toContainText("Primary answer from native-vision-fixture");
    await f.harness.close();
    reopened = await launchDesktop(f.userDataDir, { agentDir: f.agentDir, initialWorkspaces: [f.workspacePath], scrubProviderEnv: true, testMode: "background" });
    const page = await reopened.firstWindow();
    await f.http.install(reopened);
    await setDeferredThreadTitleMode(reopened);
    await expect(page.locator(".timeline-item__attachment--image")).toHaveCount(2);
    expect(f.http.requests).toHaveLength(4);
    await page.locator(".model-selector__badge").filter({ hasText: "native-vision-fixture" }).click();
    await page.locator(".model-selector__item").filter({ hasText: "deepseek-v4-pro" }).click();
    await expect(page.locator(".model-selector__badge").first()).toContainText("deepseek-v4-pro");
    await page.getByTestId("composer").fill("Read the image from the native model turn");
    await page.getByTestId("send").click();
    await expect.poll(() => f.http.requests.length).toBe(6);
    expect(f.http.requests.slice(4).map((request) => request.kind)).toEqual(["vision", "primary"]);
    expect(f.http.requests[5]!.body.model).toBe("deepseek-v4-pro");
    expect(JSON.stringify(f.http.requests[5]!.body)).not.toContain(VISION_PNG);
  } finally { await reopened?.close(); await f.harness.close().catch(() => {}); await f.http.close(); }
});

test("two windows isolate image progress, usage and cancellation even with identical pixels", async () => {
  const f = await setup();
  try {
    expect(await triggerApplicationMenuItem(f.harness, "file.new-window")).toBe(true);
    await expect.poll(() => f.harness.electronApp.windows().length).toBe(2);
    const second = f.harness.electronApp.windows().find((page) => page !== f.page)!;
    await startThreadFromSurface(second, { prompt: "SECOND_SESSION" });
    await expect(second.locator(".timeline-item--assistant")).toContainText("Primary answer");
    const firstState = await getDesktopState(f.page);
    const secondState = await getDesktopState(second);
    expect(firstState.selectedSessionId).not.toBe(secondState.selectedSessionId);
    f.http.setVisionMode("hold");
    await pasteVisionImage(f.page);
    await f.page.getByTestId("composer").fill("First window image");
    await f.page.getByTestId("send").click();
    await expect(f.page.getByTestId("vision-status")).toHaveAttribute("data-stage", "recognizing");
    await expect.poll(() => f.http.requests.filter((request) => request.kind === "vision").length).toBe(1);
    await pasteVisionImage(second);
    await second.getByTestId("composer").fill("Second window image");
    await second.getByTestId("send").click();
    await expect(second.getByTestId("vision-status")).toHaveAttribute("data-stage", "waiting");
    f.http.setVisionMode("success");
    await f.page.getByRole("button", { name: "Stop run" }).click();
    f.http.release();
    await expect(f.page.getByTestId("vision-status")).toHaveAttribute("data-stage", "cancelled");
    await expect(second.getByTestId("vision-status")).toHaveAttribute("data-stage", "completed");
    const first = await visionView(f.page), other = await visionView(second);
    expect(first.requests).toBe(1);
    expect(first.usageUnknown).toBe(true);
    expect(other.requests).toBe(1);
    expect(other.usage?.inputTokens).toBe(37);
    expect(first.images[0]!.imageId).not.toBe(other.images[0]!.imageId);
    // Security boundary probe: visible controls never request another window's session.
    const foreign = await f.page.evaluate(async (ref) => {
      try { await window.piApp!.getVisionSession(ref); return "allowed"; }
      catch (error) { return String(error); }
    }, { workspaceId: secondState.selectedWorkspaceId!, sessionId: secondState.selectedSessionId! });
    expect(foreign).toContain("does not belong");
  } finally { await f.harness.close(); await f.http.close(); }
});

test("a double send and duplicate client ID stay one message; model changes are frozen through UI and IPC", async () => {
  const f = await setup();
  try {
    f.http.setVisionMode("hold");
    await pasteVisionImage(f.page);
    await f.page.getByTestId("composer").fill("One logical image message");
    await f.page.getByTestId("send").dblclick();
    await expect(f.page.getByTestId("vision-status")).toHaveAttribute("data-stage", "recognizing");
    await expect(f.page.locator(".model-selector__badge").first()).toBeDisabled();
    const view = await visionView(f.page);
    const sourceMessageId = view.progress.at(-1)!.sourceMessageId;
    // Duplicate transport delivery and bypassing a disabled picker are not UI
    // gestures; probe those authoritative IPC contracts explicitly.
    await f.page.evaluate(async (clientMessageId) => {
      const app = window.piApp!;
      await app.submitComposer("One logical image message", { clientMessageId });
      const state = await app.getState();
      await app.setSessionModel(state.selectedWorkspaceId!, state.selectedSessionId!, "vision-fixture", "deepseek-v4-flash");
    }, sourceMessageId);
    await expect.poll(async () => (await getDesktopState(f.page)).lastError).toContain("cannot change during a run");
    await f.page.getByTestId("composer").fill("/model vision-fixture:deepseek-v4-flash");
    await f.page.getByTestId("send").click();
    await expect.poll(async () => (await getDesktopState(f.page)).lastError).toContain("cannot change during a run");
    f.http.setVisionMode("success");
    f.http.release();
    await expect(f.page.getByTestId("vision-status")).toHaveAttribute("data-stage", "completed");
    await expect(f.page.locator(".timeline-item--user", { hasText: "One logical image message" })).toHaveCount(1);
    await expect(f.page.getByTestId("queued-composer-message")).toHaveCount(0);
    expect(f.http.requests.map((request) => request.kind)).toEqual(["primary", "vision", "primary"]);
    expect(f.http.requests[2]!.body.model).toBe("deepseek-v4-pro");
  } finally { await f.harness.close(); await f.http.close(); }
});

test("a process crash preserves the original image and requires explicit retry after reopen", async () => {
  const f = await setup();
  let reopened: typeof f.harness | undefined;
  try {
    f.http.setVisionMode("hold");
    await pasteVisionImage(f.page);
    await f.page.getByTestId("composer").fill("Recover this image");
    await f.page.getByTestId("send").click();
    await expect.poll(() => f.http.requests.filter((request) => request.kind === "vision").length).toBe(1);
    await expect(f.page.getByTestId("vision-status")).toHaveAttribute("data-stage", "recognizing");
    const closed = f.harness.electronApp.waitForEvent("close");
    f.harness.electronApp.process().kill("SIGKILL"); // Only this isolated fixture app is terminated.
    await closed;
    f.http.setVisionMode("success");
    f.http.release();
    reopened = await launchDesktop(f.userDataDir, { agentDir: f.agentDir, initialWorkspaces: [f.workspacePath], scrubProviderEnv: true, testMode: "background" });
    const page = await reopened.firstWindow();
    await f.http.install(reopened);
    await setDeferredThreadTitleMode(reopened);
    await expect(page.getByTestId("vision-status")).toHaveAttribute("data-stage", "interrupted");
    await expect(page.locator(".timeline-item__attachment--image")).toHaveCount(1);
    expect(f.http.requests.map((request) => request.kind)).toEqual(["primary", "vision"]);
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.getByTestId("vision-status")).toHaveAttribute("data-stage", "completed");
    await expect(page.locator(".timeline-item--user", { hasText: "Recover this image" })).toHaveCount(1);
    expect(f.http.requests.map((request) => request.kind)).toEqual(["primary", "vision", "vision", "primary"]);
  } finally { await reopened?.close(); await f.harness.close().catch(() => {}); await f.http.close(); }
});

test("global image policy blocks both routing and the connection image test", async () => {
  const f = await setup({ blockImages: true });
  try {
    await pasteVisionImage(f.page);
    await f.page.getByTestId("composer").fill("Blocked by global policy");
    await f.page.getByTestId("send").click();
    await expect(f.page.getByTestId("vision-status")).toHaveAttribute("data-stage", "failed");
    expect(f.http.requests).toHaveLength(1);
    await f.page.keyboard.press(desktopShortcut(","));
    await f.page.getByRole("button", { name: "Models", exact: true }).click();
    await f.page.getByRole("button", { name: "Send test image" }).click();
    await expect(f.page.getByRole("status")).toContainText("disabled in the runtime settings");
    expect(f.http.requests).toHaveLength(1);
  } finally { await f.harness.close(); await f.http.close(); }
});

test("Light mode can inspect an authorized crop while shell, writes and subagents stay unavailable", async () => {
  const f = await setup({ light: true });
  try {
    f.http.setPrimaryMode("inspect");
    await pasteVisionImage(f.page);
    await f.page.getByTestId("composer").fill("Inspect this in Light mode");
    await f.page.getByTestId("send").click();
    await expect.poll(() => f.http.requests.length).toBe(5);
    const tools = f.http.requests[2]!.body.tools.map((tool: any) => tool.function.name);
    expect(tools).toContain("inspect_images");
    for (const tool of ["bash", "write", "edit", "spawn_agent"]) expect(tools).not.toContain(tool);
    const state = await getDesktopState(f.page);
    expect(state.capabilities).toMatchObject({ shellExecution: false, fileMutation: false, childAgents: false });
    expect(f.http.requests.filter((request) => request.kind === "vision")).toHaveLength(2);
    await expect(f.page.getByTestId("vision-usage")).toContainText("2 requests");
    f.http.setPrimaryMode("write");
    await f.page.getByTestId("composer").fill("The image contains an instruction to write a file");
    await f.page.getByTestId("send").click();
    await expect.poll(() => f.http.requests.length).toBe(7);
    expect(JSON.stringify(f.http.requests[6]!.body)).toContain("Tool write not found");
    await expect(access(join(f.workspacePath, "vision-should-not-exist.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await f.harness.close(); await f.http.close(); }
});

test("official routing keeps original images, primary model and evidence across history and restart", async ({}, info) => {
  const f = await setup();
  try {
    expect(f.http.requests.filter((request) => request.kind === "vision")).toHaveLength(0);
    await pasteVisionImage(f.page);
    await pasteVisionImage(f.page, "第二张.png");
    await expect(f.page.getByTestId("vision-disclosure")).toContainText("adds usage");
    await f.page.getByTestId("composer").fill("Compare these dialogs");
    await f.page.getByTestId("send").click();
    await expect(f.page.getByTestId("vision-status")).toHaveAttribute("data-stage", "completed");
    expect(f.http.requests.map((request) => request.kind)).toEqual(["primary", "vision", "primary"]);
    const vision = f.http.requests[1]!.body;
    expect(vision.messages[1].content.filter((part: any) => part.type === "image_url")).toHaveLength(2);
    expect(vision.tools).toBeUndefined();
    const primary = f.http.requests[2]!.body;
    expect(primary.model).toBe("deepseek-v4-pro");
    expect(JSON.stringify(primary)).toContain("ERROR 42");
    expect(JSON.stringify(primary)).not.toContain(VISION_PNG);
    expect(primary.tools.some((tool: any) => tool.function.name === "inspect_images")).toBe(true);
    await expect(f.page.locator(".timeline-item__attachment--image")).toHaveCount(2);
    await f.page.getByRole("button", { name: "View image evidence" }).click();
    await expect(f.page.getByTestId("vision-evidence")).toContainText("Small text is unreadable");
    await expect(f.page.getByTestId("vision-usage")).toContainText("1 requests");
    await f.page.screenshot({ path: info.outputPath("image-evidence.png"), fullPage: true });
    const before = await getSelectedTranscript(f.page);
    expect(JSON.stringify(before)).toContain(VISION_PNG);
    await f.page.getByTestId("composer").fill("Explain the known error");
    await f.page.getByTestId("send").click();
    await expect.poll(() => f.http.requests.filter((request) => request.kind === "primary").length).toBe(3);
    expect(f.http.requests.filter((request) => request.kind === "vision")).toHaveLength(1);
    await f.harness.close();
    const reopened = await launchDesktop(f.userDataDir, { agentDir: f.agentDir, initialWorkspaces: [f.workspacePath], scrubProviderEnv: true });
    try {
      await f.http.install(reopened);
      const page = await reopened.firstWindow();
      await expect(page.locator(".timeline-item__attachment--image")).toHaveCount(2);
      await page.getByRole("button", { name: "View image evidence" }).click();
      await expect(page.getByTestId("vision-evidence")).toContainText("ERROR 42");
      expect(f.http.requests.filter((request) => request.kind === "vision")).toHaveLength(1);
      await page.getByTestId("composer").fill("Remember this after restart");
      await page.getByTestId("send").click();
      await expect.poll(() => f.http.requests.filter((request) => request.kind === "primary").length).toBe(4);
      expect(f.http.requests.filter((request) => request.kind === "vision")).toHaveLength(1);
    } finally { await reopened.close(); }
  } finally { await f.harness.close().catch(() => {}); await f.http.close(); }
});

test("queued image edits and deletion do not upload until dequeue and never send an obsolete version", async () => {
  const f = await setup();
  try {
    f.http.setPrimaryMode("hold");
    await f.page.getByTestId("composer").fill("Long running primary");
    await f.page.getByTestId("send").click();
    await expect.poll(() => f.http.requests.filter((request) => request.kind === "primary").length).toBe(2);
    await pasteVisionImage(f.page, "删除测试.png");
    await f.page.getByTestId("composer").fill("Delete queued image");
    await f.page.getByTestId("send").click();
    await f.page.getByRole("button", { name: "Delete queued message Delete queued image" }).click();
    await expect(f.page.getByTestId("queued-composer-message")).toHaveCount(0);
    await pasteVisionImage(f.page, "编辑测试.png");
    await f.page.getByTestId("composer").fill("Old image question");
    await f.page.getByTestId("send").click();
    await f.page.getByTestId("queued-composer-message").getByRole("button", { name: "Edit", exact: true }).click();
    await expect(f.page.getByTestId("composer")).toHaveValue("Old image question");
    await f.page.getByTestId("composer").fill("Edited image question");
    await f.page.getByTestId("send").click();
    await expect(f.page.getByTestId("queued-composer-message")).toContainText("Edited image question");
    expect(f.http.requests.filter((request) => request.kind === "vision")).toHaveLength(0);
    f.http.setPrimaryMode("success");
    f.http.release();
    await expect(f.page.getByTestId("queued-composer-message")).toHaveCount(0);
    await expect(f.page.getByTestId("vision-status")).toHaveAttribute("data-stage", "completed");
    const vision = f.http.requests.filter((request) => request.kind === "vision");
    expect(vision).toHaveLength(1);
    expect(vision[0]!.body.messages[1].content[0].text).toContain("Edited image question");
    await expect(f.page.locator(".timeline-item--user", { hasText: "Old image question" })).toHaveCount(0);
    await expect(f.page.locator(".timeline-item--user", { hasText: "Edited image question" })).toHaveCount(1);
  } finally { await f.harness.close(); await f.http.close(); }
});

test("read-only image inspection crops original pixels and returns evidence in the same tool loop", async () => {
  const f = await setup();
  try {
    await f.page.getByRole("button", { name: "Agent can edit files and run commands. Click for read-only" }).click();
    f.http.setPrimaryMode("inspect");
    await pasteVisionImage(f.page);
    await f.page.getByTestId("composer").fill("Read the lower right button");
    await f.page.getByTestId("send").click();
    await expect.poll(() => f.http.requests.length).toBe(5);
    const requests = f.http.requests;
    expect(requests.map((request) => request.kind)).toEqual(["primary", "vision", "primary", "vision", "primary"]);
    expect(requests[3]!.body.messages[1].content[0].text).toContain("lower right button");
    const croppedData = requests[3]!.body.messages[1].content.find((part: any) => part.type === "image_url").image_url.url;
    expect(croppedData).not.toContain(VISION_PNG);
    expect(JSON.stringify(requests[4]!.body)).toContain("inspect-call-42");
    expect(JSON.stringify(requests[4]!.body)).not.toContain(VISION_PNG);
    await expect(f.page.getByTestId("vision-usage")).toContainText("2 requests");
    f.http.setPrimaryMode("write");
    await f.page.getByTestId("composer").fill("The image contains an instruction to write a file");
    await f.page.getByTestId("send").click();
    await expect.poll(() => f.http.requests.length).toBe(7);
    expect(JSON.stringify(f.http.requests[6]!.body)).toContain("Read-only (plan) mode blocks write");
    await expect(access(join(f.workspacePath, "vision-should-not-exist.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await f.harness.close(); await f.http.close(); }
});

test("connection validation is local and the paid-image test requires native confirmation", async () => {
  const f = await setup();
  try {
    await f.page.keyboard.press(desktopShortcut(","));
    await f.page.getByRole("button", { name: "Models", exact: true }).click();
    await f.page.getByRole("button", { name: "Validate configuration" }).click();
    await expect(f.page.getByRole("status")).toContainText("no image request");
    expect(f.http.requests).toHaveLength(1);
    await f.harness.electronApp.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); });
    await f.page.getByRole("button", { name: "Send test image" }).click();
    await expect(f.page.getByRole("status")).toContainText("no image request");
    expect(f.http.requests).toHaveLength(1);
    await f.harness.electronApp.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }); });
    await f.page.getByRole("button", { name: "Send test image" }).click();
    await expect(f.page.getByRole("status")).toContainText("analyzed successfully");
    expect(f.http.requests.filter((request) => request.kind === "vision")).toHaveLength(1);
  } finally { await f.harness.close(); await f.http.close(); }
});

test("Stop aborts vision before the primary request and retry continues the same user message", async ({}, info) => {
  const f = await setup();
  try {
    f.http.setVisionMode("hold");
    await pasteVisionImage(f.page);
    await f.page.getByTestId("composer").fill("Read this dialog");
    await f.page.getByTestId("send").click();
    await expect(f.page.getByTestId("vision-status")).toHaveAttribute("data-stage", "recognizing");
    await f.page.getByRole("button", { name: "Stop run" }).click();
    await expect(f.page.getByTestId("vision-status")).toHaveAttribute("data-stage", "cancelled");
    expect(f.http.requests.filter((request) => request.kind === "primary")).toHaveLength(1);
    f.http.setVisionMode("success");
    f.http.release();
    await expect(f.page.getByRole("button", { name: "Retry", exact: true })).toBeEnabled();
    await f.page.getByRole("button", { name: "Retry", exact: true }).evaluate((button) => { button.click(); button.click(); });
    await expect(f.page.getByTestId("vision-status")).toHaveAttribute("data-stage", "completed");
    await expect(f.page.locator(".timeline-item--user", { hasText: "Read this dialog" })).toHaveCount(1);
    expect(f.http.requests.filter((request) => request.kind === "vision")).toHaveLength(2);
    expect(f.http.requests.filter((request) => request.kind === "primary")).toHaveLength(2);
    await f.page.screenshot({ path: info.outputPath("cancel-retry.png"), fullPage: true });
  } finally { await f.harness.close(); await f.http.close(); }
});

test("settings disable blocks image loss; authentication failure is actionable and retry preserves the entry", async () => {
  const f = await setup();
  try {
    await f.page.keyboard.press(desktopShortcut(","));
    await f.page.getByRole("button", { name: "Models", exact: true }).click();
    await expect(f.page.getByLabel("Automatic image analysis")).toBeChecked();
    await f.page.getByLabel("Automatic image analysis").uncheck();
    await expect(f.page.getByLabel("Automatic image analysis")).toBeEnabled();
    await expect(f.page.getByLabel("Automatic image analysis")).not.toBeChecked();
    await f.page.getByRole("button", { name: "Back to app" }).click();
    await pasteVisionImage(f.page);
    await f.page.getByTestId("composer").fill("Keep this image");
    await f.page.getByTestId("send").click();
    await expect(f.page.getByTestId("vision-status")).toHaveAttribute("data-stage", "failed");
    await expect(f.page.getByTestId("vision-status")).toContainText("Enable image assistance");
    expect(f.http.requests).toHaveLength(1);
    await f.page.keyboard.press(desktopShortcut(","));
    await expect(f.page.getByLabel("Automatic image analysis")).toBeEnabled();
    await f.page.getByLabel("Automatic image analysis").check();
    await expect(f.page.getByLabel("Automatic image analysis")).toBeEnabled();
    await f.page.getByRole("button", { name: "Back to app" }).click();
    f.http.setVisionMode("auth");
    await f.page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(f.page.getByTestId("vision-status")).toContainText("credentials");
    expect(f.http.requests.filter((request) => request.kind === "vision")).toHaveLength(1);
    f.http.setVisionMode("success");
    await f.page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(f.page.getByTestId("vision-status")).toHaveAttribute("data-stage", "completed");
    await expect(f.page.locator(".timeline-item--user", { hasText: "Keep this image" })).toHaveCount(1);
    const state = await getDesktopState(f.page);
    expect(state.lastError).toBeUndefined();
  } finally { await f.harness.close(); await f.http.close(); }
});
