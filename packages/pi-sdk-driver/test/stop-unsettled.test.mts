import test from "node:test";
import assert from "node:assert/strict";
import { makeSupervisedSession, waitUntil } from "./supervised-session-fixture.mts";

/**
 * Outlives the 2s Stop settle window by ignoring its abort signal, like a tool
 * blocked on I/O that cannot be interrupted.
 */
const stubbornTool = {
  name: "stubborn_tool",
  label: "Stubborn tool",
  description: "Test-only tool that ignores its abort signal for a while.",
  parameters: { type: "object" as const, properties: {} },
  async execute() {
    await new Promise((resolve) => setTimeout(resolve, 2_600));
    return { content: [{ type: "text" as const, text: "finally done" }], details: {} };
  },
};

test("a message sent after a Stop that outlived its settle window waits for the stopped run instead of failing", async () => {
  const fixture = await makeSupervisedSession(
    "stop-unsettled",
    [{ kind: "tool", name: stubbornTool.name, arguments: {} }, { kind: "text", deltas: ["second ", "answer"] }],
    { customTools: [stubbornTool] },
  );
  try {
    const firstRun = fixture.supervisor.sendUserMessage(fixture.ref, { text: "start the slow tool" }).catch(() => {});
    await waitUntil(() => fixture.events.some((event) => event.type === "toolStarted"));

    // Stop gives up waiting after 2s and reports the session idle, while the
    // tool is still running and pi still considers the run active.
    await fixture.supervisor.cancelCurrentRun(fixture.ref);

    // Before: rejected at once with "Session is already streaming".
    await fixture.supervisor.sendUserMessage(fixture.ref, { text: "next question" });
    await waitUntil(() => fixture.events.filter((event) => event.type === "assistantDelta").map((event) => event.text).join("") === "second answer");
    await waitUntil(() => fixture.events.at(-1)?.snapshot?.status === "idle");
    await firstRun;
  } finally {
    await fixture.cleanup();
  }
});
