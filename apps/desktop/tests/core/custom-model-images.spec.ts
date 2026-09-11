import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  createNamedThread,
  desktopShortcut,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  openNewThread,
  pasteTinyPng,
  seedAgentDir,
  TINY_PNG_BASE64,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";
import { pasteVisionImage, seedVisionAgentDir, startVisionHttpFixture, VISION_PNG, VISION_TEST_PROVIDER } from "../helpers/vision-fixture";

interface CompletionRequest {
  readonly model: string;
  readonly stream?: boolean;
  readonly messages: readonly {
    readonly role: string;
    readonly content: string | readonly { readonly type: string; readonly image_url?: { readonly url: string } }[];
  }[];
}

function lastUserImages(request: CompletionRequest): string[] {
  const content = request.messages.filter((message) => message.role === "user").at(-1)?.content;
  return Array.isArray(content)
    ? content.flatMap((block) => block.type === "image_url" ? [block.image_url.url] : [])
    : [];
}

async function startImageServer() {
  const requests: CompletionRequest[] = [];
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "vision-model" }, { id: "text-model" }] }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as CompletionRequest;
      requests.push(body);
      const content = `${lastUserImages(body).length ? "Screenshot" : "Text"} accepted #${requests.length}`;
      const completion = { id: `image-test-${requests.length}`, model: body.model, created: 0 };
      if (body.stream) {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.end(`data: ${JSON.stringify({
          ...completion, object: "chat.completion.chunk",
          choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: "stop" }],
        })}\n\ndata: [DONE]\n\n`);
      } else {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ...completion, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] }));
      }
    } catch (error) {
      response.writeHead(500).end(String(error));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

async function openProviders(window: Page) {
  await window.keyboard.press(desktopShortcut(","));
  await expect(window.getByTestId("settings-surface")).toBeVisible();
  await window.getByRole("button", { name: "Providers", exact: true }).click();
}

async function editEndpoint(window: Page, providerId: string) {
  await openProviders(window);
  const row = window.locator(".settings-row", {
    has: window.locator(".settings-row__title", { hasText: new RegExp(`^${providerId}$`) }),
  });
  await row.getByRole("button", { name: "Edit", exact: true }).click();
  return window.getByTestId("custom-endpoint-dialog");
}

async function closeSettings(window: Page) {
  await window.getByRole("button", { name: "Back to app", exact: true }).click();
  await expect(window.getByTestId("composer")).toBeVisible();
}

test("custom model images reach the real request and capability edits preserve the active session and failed draft", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const server = await startImageServer();
  const userDataDir = await makeUserDataDir("custom-model-images-");
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("custom-model-images-workspace");
  await seedAgentDir(agentDir, { withCustomProvider: false, withOpenAiAuth: false, withDefaultModel: false });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: "vision-api", defaultModel: "vision-model", enabledModels: ["vision-api/vision-model"],
  }));
  const launchOptions = { agentDir, initialWorkspaces: [workspacePath], scrubProviderEnv: true, testMode: "background" as const };
  let harness = await launchDesktop(userDataDir, launchOptions);
  try {
    let window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await openProviders(window);
    await window.getByRole("button", { name: "Add endpoint", exact: true }).click();
    const createDialog = window.getByTestId("custom-endpoint-dialog");
    await createDialog.getByLabel("Provider ID").fill("vision-api");
    await createDialog.getByLabel("Base URL").fill(server.baseUrl);
    await createDialog.getByRole("button", { name: "Detect models", exact: true }).click();
    await expect(createDialog.getByLabel("Image input for vision-model", { exact: true })).toBeDisabled();
    await createDialog.getByLabel("Enable vision-model", { exact: true }).check();
    await createDialog.getByLabel("Enable text-model", { exact: true }).check();
    await expect(createDialog.getByLabel("Image input for vision-model", { exact: true })).not.toBeChecked();
    await createDialog.getByRole("button", { name: "Add endpoint", exact: true }).click();
    await expect(createDialog).toHaveCount(0);
    await window.getByRole("button", { name: "Back to app", exact: true }).click();

    // Materialize a real text-only session before editing the registry.
    await createNamedThread(window, "Image capability session");
    await window.getByTestId("composer").fill("Hello before enabling vision");
    await window.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(window.locator(".timeline")).toContainText("Text accepted #1", { timeout: 20_000 });
    const sessionId = (await getDesktopState(window)).selectedSessionId;

    let dialog = await editEndpoint(window, "vision-api");
    await dialog.getByLabel("Image input for vision-model", { exact: true }).check();
    await expect(dialog.getByLabel("Image input for text-model", { exact: true })).not.toBeChecked();
    await window.screenshot({ path: testInfo.outputPath("image-settings-enabled.png") });
    await dialog.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await closeSettings(window);
    await pasteTinyPng(window, "first-screenshot.png");
    await window.getByTestId("composer").fill("Inspect this screenshot");
    await window.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(window.locator(".timeline")).toContainText("Screenshot accepted #2", { timeout: 20_000 });
    expect(lastUserImages(server.requests[1]!)).toEqual([`data:image/png;base64,${TINY_PNG_BASE64}`]);
    expect(JSON.stringify(server.requests[1])).not.toContain("image omitted");
    expect((await getDesktopState(window)).selectedSessionId).toBe(sessionId);

    dialog = await editEndpoint(window, "vision-api");
    await dialog.getByLabel("Image input for vision-model", { exact: true }).uncheck();
    await dialog.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await closeSettings(window);
    const retryPrompt = "Inspect the retained screenshot";
    await pasteTinyPng(window, "retained-screenshot.png");
    await window.getByTestId("composer").fill(retryPrompt);
    await window.getByRole("button", { name: "Send message", exact: true }).click();
    await expect.poll(async () => (await getDesktopState(window)).lastError).toContain("Image input is not enabled");
    await expect(window.getByTestId("composer")).toHaveValue(retryPrompt);
    await expect(window.locator(".composer-attachment")).toContainText("retained-screenshot.png");
    await expect(window.locator(".timeline")).not.toContainText(retryPrompt);
    expect(server.requests).toHaveLength(2);
    const failedState = await getDesktopState(window);
    expect(failedState.workspaces.flatMap((workspace) => workspace.sessions).find((session) => session.id === sessionId)?.status).toBe("idle");
    await window.screenshot({ path: testInfo.outputPath("image-input-disabled-draft-retained.png") });

    dialog = await editEndpoint(window, "vision-api");
    await dialog.getByLabel("Image input for vision-model", { exact: true }).check();
    await dialog.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await closeSettings(window);
    await expect(window.getByTestId("composer")).toHaveValue(retryPrompt);
    await window.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(window.locator(".timeline")).toContainText("Screenshot accepted #3", { timeout: 20_000 });
    expect(lastUserImages(server.requests[2]!)).toEqual([`data:image/png;base64,${TINY_PNG_BASE64}`]);
    await expect(window.locator(".composer-attachment")).toHaveCount(0);
    await window.screenshot({ path: testInfo.outputPath("image-request-retry-succeeded.png") });

    await harness.close();
    harness = await launchDesktop(userDataDir, launchOptions);
    window = await harness.firstWindow();
    dialog = await editEndpoint(window, "vision-api");
    await expect(dialog.getByLabel("Image input for vision-model", { exact: true })).toBeChecked();
    await expect(dialog.getByLabel("Image input for text-model", { exact: true })).not.toBeChecked();
    const saved = JSON.parse(await readFile(join(agentDir, "models.json"), "utf8"));
    expect(saved.providers["vision-api"].models).toEqual([
      { id: "vision-model", input: ["text", "image"] },
      { id: "text-model", input: ["text"] },
    ]);
  } finally {
    await harness.close();
    await server.close();
  }
});

test("startup migrates only missing official DeepSeek Flash image capabilities before loading models", async ({}, testInfo) => {
  const userDataDir = await makeUserDataDir("deepseek-legacy-images-");
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("deepseek-legacy-images-workspace");
  await seedAgentDir(agentDir, { withCustomProvider: false, withOpenAiAuth: false, withDefaultModel: false, enabledModels: [] });
  const original = JSON.stringify({ providers: { "deepseek-api": {
    baseUrl: "https://api.deepseek.com/v1", api: "openai-completions", apiKey: "unused", piGuiCustomEndpoint: true,
    models: [{ id: "deepseek-flash" }, { id: "deepseek-v4-flash", input: ["text"] }, { id: "deepseek-v4-pro" }],
  } } }, null, 2);
  await writeFile(join(agentDir, "models.json"), original);
  const harness = await launchDesktop(userDataDir, { agentDir, initialWorkspaces: [workspacePath], scrubProviderEnv: true, testMode: "background" });
  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await expect.poll(async () => Object.values((await getDesktopState(window)).runtimeByWorkspace)
      .flatMap((runtime) => runtime.models)
      .find((model) => model.providerId === "deepseek-api" && model.modelId === "deepseek-flash")?.supportsImages).toBe(true);
    const dialog = await editEndpoint(window, "deepseek-api");
    await expect(dialog.getByLabel("Image input for deepseek-flash", { exact: true })).toBeChecked();
    await expect(dialog.getByLabel("Image input for deepseek-v4-flash", { exact: true })).not.toBeChecked();
    await expect(dialog.getByLabel("Image input for deepseek-v4-pro", { exact: true })).not.toBeChecked();
    expect(await readFile(join(agentDir, "models.json.bak"), "utf8")).toBe(original);
    await window.screenshot({ path: testInfo.outputPath("deepseek-legacy-image-default.png") });
  } finally {
    await harness.close();
  }
});

test("a new image-only thread keeps its screenshot after rejection and can retry using Chinese settings", async ({}, testInfo) => {
  test.setTimeout(90_000);
  const server = await startImageServer();
  const userDataDir = await makeUserDataDir("new-thread-image-input-");
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("new-thread-image-input-workspace");
  await seedAgentDir(agentDir, { withCustomProvider: false, withOpenAiAuth: false, withDefaultModel: false });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: "vision-api", defaultModel: "vision-model", enabledModels: ["vision-api/vision-model"],
  }));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "vision-api": {
    baseUrl: server.baseUrl, api: "openai-completions", apiKey: "unused", piGuiCustomEndpoint: true,
    models: [{ id: "vision-model", input: ["text"] }],
  } } }));
  const harness = await launchDesktop(userDataDir, { agentDir, initialWorkspaces: [workspacePath], scrubProviderEnv: true, testMode: "background" });
  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await window.keyboard.press(desktopShortcut(","));
    await window.getByRole("button", { name: "General", exact: true }).click();
    await window.getByRole("button", { name: "简体中文", exact: true }).click();
    await window.getByRole("button", { name: "返回应用", exact: true }).click();
    await window.locator(".sidebar").getByRole("button", { name: "新建对话", exact: true }).click();
    await expect(window.getByTestId("new-thread-composer")).toBeVisible();
    await pasteTinyPng(window, "首次截图.png", "new-thread-composer");
    await window.getByRole("button", { name: "开始对话", exact: true }).click();
    await expect(window.getByTestId("composer")).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => (await getDesktopState(window)).lastError).toContain("未启用图片输入");
    await expect(window.locator(".composer-attachment")).toContainText("首次截图.png");
    await expect(window.locator(".timeline-item__attachment")).toHaveCount(0);
    expect(server.requests).toHaveLength(0);
    await window.screenshot({ path: testInfo.outputPath("new-thread-image-rejected-zh.png") });

    await window.keyboard.press(desktopShortcut(","));
    await window.getByRole("button", { name: "模型服务", exact: true }).click();
    const row = window.locator(".settings-row", {
      has: window.locator(".settings-row__title", { hasText: /^vision-api$/ }),
    });
    await row.getByRole("button", { name: "编辑", exact: true }).click();
    const dialog = window.getByTestId("custom-endpoint-dialog");
    await dialog.getByLabel("vision-model 接受图片", { exact: true }).check();
    await window.screenshot({ path: testInfo.outputPath("image-settings-zh.png") });
    await dialog.getByRole("button", { name: "保存更改", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await window.getByRole("button", { name: "返回应用", exact: true }).click();
    await expect(window.locator(".composer-attachment")).toContainText("首次截图.png");
    await window.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(window.locator(".timeline")).toContainText("Screenshot accepted #1", { timeout: 20_000 });
    expect(lastUserImages(server.requests[0]!)).toEqual([`data:image/png;base64,${TINY_PNG_BASE64}`]);
    await expect(window.locator(".composer-attachment")).toHaveCount(0);
  } finally {
    await harness.close();
    await server.close();
  }
});

test("legacy official Flash uses native image input without an auxiliary-model notice or request", async ({}, testInfo) => {
  const userDataDir = await makeUserDataDir("native-deepseek-flash-");
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("native-deepseek-flash-workspace");
  await seedVisionAgentDir(agentDir, { modelId: "deepseek-v4-flash" });
  const path = join(agentDir, "models.json");
  const legacy = JSON.parse(await readFile(path, "utf8"));
  delete legacy.providers[VISION_TEST_PROVIDER].models.find((model: { id: string }) => model.id === "deepseek-v4-flash").input;
  await writeFile(path, JSON.stringify(legacy));
  const http = await startVisionHttpFixture();
  const harness = await launchDesktop(userDataDir, { agentDir, initialWorkspaces: [workspacePath], scrubProviderEnv: true, testMode: "background" });
  try {
    const window = await harness.firstWindow();
    await http.install(harness);
    await waitForWorkspaceByPath(window, workspacePath);
    await openNewThread(window);
    await pasteTinyPng(window, "native-first-screenshot.png", "new-thread-composer");
    await expect(window.getByTestId("vision-disclosure")).toHaveCount(0);
    await window.getByRole("button", { name: "Start thread", exact: true }).click();
    await expect(window.locator(".timeline")).toContainText("Primary answer from deepseek-v4-flash", { timeout: 20_000 });
    expect(http.requests.map((request) => request.kind)).toEqual(["primary"]);
    expect(lastUserImages(http.requests[0]!.body)).toEqual([`data:image/png;base64,${TINY_PNG_BASE64}`]);

    await pasteVisionImage(window);
    await expect(window.getByTestId("vision-disclosure")).toHaveCount(0);
    await window.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(window.locator(".timeline-item--assistant")).toHaveCount(2, { timeout: 20_000 });
    expect(http.requests.map((request) => request.kind)).toEqual(["primary", "primary"]);
    expect(lastUserImages(http.requests[1]!.body)).toEqual([`data:image/png;base64,${VISION_PNG}`]);
    await expect(window.getByTestId("vision-status")).toHaveCount(0);
    await window.screenshot({ path: testInfo.outputPath("native-deepseek-flash-image-request.png") });
  } finally {
    await harness.close();
    await http.close();
  }
});
