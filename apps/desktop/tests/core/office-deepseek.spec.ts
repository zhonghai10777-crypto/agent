import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  type PiAppWindow,
} from "../helpers/electron-app";
import { createWordDocument } from "../../electron/office-runtime";

interface CapturedRequest {
  readonly messages?: readonly unknown[];
  readonly tools?: readonly unknown[];
}

async function startDeepSeekCompatibleServer(sourcePath: string): Promise<{
  readonly baseUrl: string;
  readonly requests: readonly CapturedRequest[];
  readonly close: () => Promise<void>;
}> {
  const requests: CapturedRequest[] = [];
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer(async (request, response) => {
    const body = await readJsonBody(request);
    requests.push(body);
    const requestNumber = requests.length;
    if (requestNumber === 1) {
      sendToolCall(response, "office-invalid", "word_replace", {
        sourcePath: "/tmp/not-attached.docx",
        search: "原始内容",
        replacement: "第一次重试",
      });
      return;
    }
    if (requestNumber === 2) {
      sendToolCall(response, "office-valid", "word_replace", {
        sourcePath,
        search: "原始内容",
        replacement: "已更新内容",
      });
      return;
    }
    sendText(response, "已完成办公修改。");
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}

test("DeepSeek-compatible endpoint handles simple office schemas, Chinese arguments, and a tool retry", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir("office-deepseek-");
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("office-deepseek-workspace");
  const sourcePath = join(workspacePath, "report.docx");
  await writeFile(sourcePath, createWordDocument(undefined, ["原始内容"]));
  const server = await startDeepSeekCompatibleServer(sourcePath);
  await seedAgentDir(agentDir, {
    withOpenAiAuth: false,
    withDefaultModel: false,
    enabledModels: ["deepseek-compatible/deepseek-chat"],
  });
  await writeFile(join(agentDir, "settings.json"), `${JSON.stringify({
    defaultProvider: "deepseek-compatible",
    defaultModel: "deepseek-chat",
    enabledModels: ["deepseek-compatible/deepseek-chat"],
  }, null, 2)}\n`);
  await writeFile(join(agentDir, "models.json"), `${JSON.stringify({
    providers: {
      "deepseek-compatible": {
        baseUrl: server.baseUrl,
        api: "openai-completions",
        apiKey: "unused",
        models: [{ id: "deepseek-chat" }],
      },
    },
  }, null, 2)}\n`);
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
    envOverrides: { PI_APP_DEFAULT_RUNTIME_MODE: "light" },
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "DeepSeek office session");
    await window.evaluate(() => {
      const app = (window as PiAppWindow).piApp;
      if (!app) throw new Error("piApp IPC bridge is unavailable");
      void app.submitComposer("请把报告中的原始内容替换为已更新内容");
    });

    const dialog = window.getByTestId("extension-dialog");
    await expect(dialog).toContainText("确认办公文件写入", { timeout: 20_000 });
    await expect(dialog).toContainText("变更项：1");
    await dialog.getByTestId("extension-dialog-confirm").click();
    await expect(window.locator(".timeline")).toContainText("已完成办公修改。", { timeout: 20_000 });

    await expect.poll(() => server.requests.length).toBe(3);
    const firstRequest = server.requests[0];
    const officeTools = (firstRequest?.tools ?? []).filter((tool) => {
      const name = ((tool as { function?: { name?: unknown } }).function?.name);
      return typeof name === "string" && (name.startsWith("word_") || name.startsWith("excel_"));
    });
    expect(officeTools).toHaveLength(7);
    expect(JSON.stringify(officeTools)).not.toContain("oneOf");
    expect(JSON.stringify(server.requests[1]?.messages)).toContain("源文件不在当前工作区或会话附件范围内");

    const editedBytes = await readFile(join(workspacePath, "report.edited.docx"));
    expect(new TextDecoder().decode((await import("fflate")).unzipSync(editedBytes)["word/document.xml"]))
      .toContain("已更新内容");
  } finally {
    await harness.close();
    await server.close();
  }
});

async function readJsonBody(request: IncomingMessage): Promise<CapturedRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as CapturedRequest;
}

function sendToolCall(
  response: ServerResponse,
  id: string,
  name: string,
  args: Readonly<Record<string, unknown>>,
): void {
  sendEvents(response, [
    {
      id: `chatcmpl-${id}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "deepseek-chat",
      choices: [{
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [{
            index: 0,
            id,
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          }],
        },
        finish_reason: null,
      }],
    },
    {
      id: `chatcmpl-${id}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "deepseek-chat",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    },
  ]);
}

function sendText(response: ServerResponse, content: string): void {
  sendEvents(response, [{
    id: "chatcmpl-final",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "deepseek-chat",
    choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: "stop" }],
  }]);
}

function sendEvents(response: ServerResponse, events: readonly unknown[]): void {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end("data: [DONE]\n\n");
}
