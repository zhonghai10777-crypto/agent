import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  startThreadViaIpc,
  type PiAppWindow,
} from "../helpers/electron-app";

/**
 * Real-scenario reproduction: does Stop actually interrupt a genuinely running
 * turn? A hanging model server leaves the first request in flight (never
 * acknowledged), so the turn is truly "running". Invoking cancelCurrentRun must
 * return the session to idle and keep it idle — not flip to running or failed
 * on late abort fallout — and the session must stay usable for a new message.
 */
async function startHangingServer(): Promise<{
  readonly baseUrl: string;
  readonly requestCount: () => number;
  readonly close: () => Promise<void>;
}> {
  let requests = 0;
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((request) => {
    requests += 1;
    if (requests === 1) {
      // First request never responds: the model turn hangs forever (the request is
      // in flight, never acknowledged), giving Stop a genuinely running turn to
      // interrupt. The request stays open until the socket is destroyed by abort.
      request.resume();
      return;
    }
    // Later requests respond so the session stays usable after the stop.
    request.resume();
    const body = JSON.stringify({
      id: "cmpl-" + requests,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "hang",
      choices: [{ index: 0, delta: { content: "done." }, finish_reason: "stop" }],
    });
    request.socket.write(
      `HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\ndata: ${body}\r\n\r\ndata: [DONE]\r\n\r\n`,
    );
    request.socket.end();
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
    requestCount: () => requests,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

test("stop interrupts a genuinely running turn backed by a hanging model server", async () => {
  test.setTimeout(120_000);

  const server = await startHangingServer();
  const userDataDir = await makeUserDataDir("debug-stop-live-");
  const agentDir = join(userDataDir, "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "auth.json"), `${JSON.stringify({}, null, 2)}\n`);
  await writeFile(join(agentDir, "models.json"), `${JSON.stringify({
    providers: {
      "hanging-test": {
        baseUrl: server.baseUrl,
        api: "openai-completions",
        apiKey: "unused",
        models: [{ id: "hang" }],
      },
    },
  }, null, 2)}\n`);
  await writeFile(join(agentDir, "settings.json"), `${JSON.stringify({
    defaultProvider: "hanging-test",
    defaultModel: "hang",
    enabledModels: ["hanging-test/hang"],
  }, null, 2)}\n`);

  const workspacePath = await makeWorkspace("debug-stop-live-workspace");
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();

    // Send a real prompt via IPC (fire-and-forget: the hanging server keeps the
    // turn running forever, and we must not block on the send completing).
    await startThreadViaIpc(window, {
      prompt: "Work on this forever, never finish.",
    });

    // The turn is genuinely running now (the model request is in flight).
    await expect(window.getByRole("button", { name: "Stop run" })).toBeVisible({ timeout: 20_000 });
    expect(server.requestCount()).toBeGreaterThan(0);

    // Drive Stop through the IPC interface (the same handler the button calls).
    const stateAfterStop = await window.evaluate(async () => {
      const app = (window as PiAppWindow).piApp;
      if (!app) {
        throw new Error("piApp IPC bridge is unavailable");
      }
      return app.cancelCurrentRun();
    });
    expect(stateAfterStop).toBeTruthy();

    // The session must return to idle and STAY idle (Send message reappears).
    await expect(window.getByRole("button", { name: "Send message" })).toBeVisible({ timeout: 20_000 });

    // Give a late tool event a chance to flip the status back to running.
    const stateAfter = await getDesktopState(window);
    const sessionAfter = stateAfter.workspaces
      .flatMap((w) => w.sessions)
      .find((s) => s.id === stateAfter.selectedSessionId);
    expect(sessionAfter?.status, `expected idle, got ${sessionAfter?.status}`).toBe("idle");

    // After a clean stop the session must be usable again: a new message starts a
    // fresh turn rather than being rejected as "still streaming". The re-send must
    // reach the server and not raise an error.
    const stateAfterSecondSend = await window.evaluate(async () => {
      const app = (window as PiAppWindow).piApp;
      if (!app) {
        throw new Error("piApp IPC bridge is unavailable");
      }
      return app.submitComposer("One more message after the stop.");
    });
    expect(stateAfterSecondSend).toBeTruthy();
    expect(server.requestCount()).toBeGreaterThan(1);
    expect(stateAfterSecondSend.lastError).toBeUndefined();
  } finally {
    await harness.close();
    await server.close();
  }
});

/**
 * The ghost-idle race: Stop, then send a new message immediately. pi's agent
 * events carry no run identifier, so if the stopped run's agent_end lands after
 * the next run has begun, it is attributed to the wrong run — flipping a live
 * run to "idle" (Stop button gone, Send enabled, mid-answer) and firing a
 * spurious "run finished" notification. The fix sequences the two runs, so this
 * asserts the new run is still reported as running after the old one settles.
 */
test("a new message sent right after Stop is not flipped to idle by the stopped run", async () => {
  test.setTimeout(120_000);

  const server = await startHangingServer();
  const userDataDir = await makeUserDataDir("stop-then-send-");
  const agentDir = join(userDataDir, "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "auth.json"), `${JSON.stringify({}, null, 2)}\n`);
  await writeFile(join(agentDir, "models.json"), `${JSON.stringify({
    providers: {
      "hanging-test": {
        baseUrl: server.baseUrl,
        api: "openai-completions",
        apiKey: "unused",
        models: [{ id: "hang" }],
      },
    },
  }, null, 2)}\n`);
  await writeFile(join(agentDir, "settings.json"), `${JSON.stringify({
    defaultProvider: "hanging-test",
    defaultModel: "hang",
    enabledModels: ["hanging-test/hang"],
  }, null, 2)}\n`);

  const workspacePath = await makeWorkspace("stop-then-send-workspace");
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await startThreadViaIpc(window, { prompt: "Hang forever, never finish." });
    await expect(window.getByRole("button", { name: "Stop run" })).toBeVisible({ timeout: 20_000 });

    // Stop and send back-to-back, with no wait in between — the tight window
    // that used to let the stopped run's late agent_end land on the new run.
    const stateAfterSecondSend = await window.evaluate(async () => {
      const app = (window as PiAppWindow).piApp;
      if (!app) {
        throw new Error("piApp IPC bridge is unavailable");
      }
      await app.cancelCurrentRun();
      return app.submitComposer("Second question, right after the stop.");
    });
    expect(stateAfterSecondSend).toBeTruthy();
    expect(stateAfterSecondSend.lastError).toBeUndefined();

    // Give any late fallout from the stopped run time to arrive and be
    // (incorrectly) applied. The second request is answered by the server, so
    // the session legitimately settles to idle — what must NOT happen is a
    // failed status or a surfaced error from the stopped run.
    await expect(window.getByRole("button", { name: "Send message" })).toBeVisible({ timeout: 20_000 });

    const stateAfter = await getDesktopState(window);
    const sessionAfter = stateAfter.workspaces
      .flatMap((w) => w.sessions)
      .find((s) => s.id === stateAfter.selectedSessionId);
    expect(sessionAfter?.status, `expected idle, got ${sessionAfter?.status}`).toBe("idle");
    expect(stateAfter.lastError).toBeUndefined();
    // The second prompt actually reached the model rather than being swallowed
    // by the still-unwinding first run.
    expect(server.requestCount()).toBeGreaterThan(1);
  } finally {
    await harness.close();
    await server.close();
  }
});
