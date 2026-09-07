import { createAssistantMessageEventStream, type AssistantMessage, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { VisionContext, VisionMessage } from "./vision-protocol.js";
import { assertTextOnlyPayload, type VisionRouter, type VisionSessionBinding } from "../vision-router.js";
import { assertVisionActive, raceVisionAbort, VisionError } from "../vision-errors.js";

type Agent = AgentSession["agent"];
type Stream = Agent["streamFunction"];
const installed = new WeakMap<Agent, { dispose(): void }>();

export function installVisionStreamAdapter(session: Pick<AgentSession, "agent">, router: VisionRouter, binding: VisionSessionBinding): () => void {
  const agent = session.agent;
  installed.get(agent)?.dispose();
  const original = agent.streamFunction;
  const lifetime = new AbortController();
  const wrapper: Stream = (model, context, options) => {
    if (model.input.includes("image")) return original(model, context, options);
    const output = createAssistantMessageEventStream();
    const generation = router.currentGeneration(binding.ref);
    const controller = new AbortController();
    const abort = () => controller.abort();
    for (const source of [lifetime.signal, options?.signal]) {
      if (source?.aborted) abort();
      else source?.addEventListener("abort", abort, { once: true });
    }
    let primaryStarted = false;
    const assertCurrent = () => {
      assertVisionActive(controller.signal);
      if (generation !== undefined && router.currentGeneration(binding.ref) !== generation) throw new VisionError("VISION_CANCELLED", "A newer turn replaced this model request.");
    };
    void (async () => {
      try {
        await binding.beforeRequest?.();
        assertCurrent();
        const projected = await raceVisionAbort(router.project(model, context, binding, controller.signal), controller.signal);
        assertCurrent();
        const nextOptions: SimpleStreamOptions = {
          ...options,
          signal: controller.signal,
          onPayload: async (payload, requestModel) => {
            // Respect the SDK/extension transform before checking what will actually be sent.
            const transformed = await options?.onPayload?.(payload, requestModel);
            const final = transformed === undefined ? payload : transformed;
            assertCurrent();
            assertTextOnlyPayload(final);
            return final;
          },
        };
        primaryStarted = true;
        const stream = await raceVisionAbort(Promise.resolve(original(model, projected, nextOptions)), controller.signal);
        const iterator = stream[Symbol.asyncIterator]();
        let terminal = false;
        try {
          while (true) {
            const item = await raceVisionAbort(iterator.next(), controller.signal);
            if (item.done) break;
            assertCurrent();
            output.push(item.value);
            if (item.value.type === "done" || item.value.type === "error") {
              terminal = true;
              break;
            }
          }
          if (!terminal) throw new Error("The original model stream ended without a terminal event.");
        } finally {
          if (iterator.return) void Promise.resolve(iterator.return()).catch(() => {});
        }
      } catch (error) {
        const cancelled = controller.signal.aborted || error instanceof VisionError && error.code === "VISION_CANCELLED";
        const localError = error instanceof VisionError || !primaryStarted;
        if (localError && (error instanceof VisionError || context.messages.some((message) => Array.isArray(message.content) && message.content.some((part) => part.type === "image")))) {
          await router.reportFailure(binding, error, model.id, generation);
        }
        // Pi retries network-looking error strings. Detailed VISION_* errors live
        // in progress; this terminal local message intentionally has no retry trigger.
        const errorMessage = cancelled ? (primaryStarted ? "Model request cancelled." : "Image analysis cancelled.") : localError
          ? "Image analysis stopped. See the image status for details and retry explicitly."
          : error instanceof Error ? error.message : "The model stream failed.";
        const message: AssistantMessage = {
          role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
          stopReason: cancelled ? "aborted" : "error", errorMessage, timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
        output.push({ type: "error", reason: cancelled ? "aborted" : "error", error: message });
      } finally {
        lifetime.signal.removeEventListener("abort", abort);
        options?.signal?.removeEventListener("abort", abort);
      }
    })();
    return output;
  };
  agent.streamFunction = wrapper;
  const dispose = () => {
    lifetime.abort();
    if (agent.streamFunction === wrapper) agent.streamFunction = original;
    installed.delete(agent);
  };
  installed.set(agent, { dispose });
  return dispose;
}

export interface VisionSummaryBinding {
  readonly session: AgentSession;
  readonly binding: VisionSessionBinding;
}

/** Project summary inputs before Pi serializes image blocks into text placeholders. */
export function createVisionSummaryExtension(router: VisionRouter, resolve: (ctx: ExtensionContext) => VisionSummaryBinding | undefined): ExtensionFactory {
  return (pi) => {
    pi.on("session_before_compact", async (event, ctx) => {
      const target = resolve(ctx);
      if (!target?.session.model || target.session.settingsManager.getBlockImages()) return;
      const { preparation } = event;
      try {
        const projected = await projectSummaryMessages(router, target, [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages], event.signal);
        const split = preparation.messagesToSummarize.length;
        preparation.messagesToSummarize = projected.slice(0, split) as typeof preparation.messagesToSummarize;
        preparation.turnPrefixMessages = projected.slice(split) as typeof preparation.turnPrefixMessages;
      } catch { return { cancel: true }; }
    });
    pi.on("session_before_tree", async (event, ctx) => {
      if (!event.preparation.userWantsSummary) return;
      const target = resolve(ctx);
      if (!target?.session.model || target.session.settingsManager.getBlockImages()) return;
      const entries = event.preparation.entriesToSummarize;
      const messages = entries.filter((entry) => entry.type === "message").map((entry) => entry.message);
      try {
        const projected = await projectSummaryMessages(router, target, messages, event.signal);
        let index = 0;
        // Keep the array identity used by Pi's default branch summarizer while
        // replacing only preparation entries, never the SessionManager's entries.
        for (let i = 0; i < entries.length; i += 1) {
          const entry = entries[i]!;
          if (entry.type === "message") entries[i] = { ...entry, message: projected[index++]! as typeof entry.message };
        }
      } catch { return { cancel: true }; }
    });
  };
}

async function projectSummaryMessages(router: VisionRouter, target: VisionSummaryBinding, messages: readonly unknown[], signal: AbortSignal): Promise<unknown[]> {
  const compatible = messages.filter((message) => ["user", "assistant", "toolResult"].includes((message as { role: string }).role)) as VisionMessage[];
  const context: VisionContext = { messages: compatible };
  const result = await router.projectSummary(target.session.model!, context, target.binding, signal);
  let index = 0;
  return messages.map((message) => compatible.includes(message as VisionMessage) ? result.messages[index++]! : message);
}
