import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

export type NormalizedAgentEvent =
  | { type: "run-started"; timestamp: string }
  | { type: "assistant-delta"; text: string; timestamp: string }
  | { type: "tool-started"; callId: string; toolName: string; input?: unknown; timestamp: string }
  | { type: "tool-updated"; callId: string; detail?: string; progress?: number; timestamp: string }
  | { type: "tool-finished"; callId: string; success: boolean; output?: unknown; timestamp: string }
  | { type: "run-retrying"; error: Error; timestamp: string }
  | { type: "run-settled"; success: boolean; cancelled: boolean; error?: Error; timestamp: string }
  | { type: "unknown"; sourceType: string; timestamp: string };

export interface AgentEventNormalizationContext {
  readonly timestamp?: string;
  readonly success?: boolean;
  readonly cancelled?: boolean;
  readonly error?: Error;
}

export interface AgentEventNormalizer {
  normalize(event: AgentSessionEvent, context?: AgentEventNormalizationContext): NormalizedAgentEvent | undefined;
  markSettled(): void;
  reset(): void;
}

/**
 * A per-session normalizer. It treats retries as non-terminal and suppresses
 * the `agent_settled` backstop after a terminal `agent_end` has already fired.
 */
export function createAgentEventNormalizer(): AgentEventNormalizer {
  let terminalEmitted = false;

  return {
    reset() {
      terminalEmitted = false;
    },
    markSettled() {
      terminalEmitted = true;
    },
    normalize(event, context = {}) {
      const timestamp = context.timestamp ?? new Date().toISOString();
      switch (event.type) {
        case "agent_start":
        case "turn_start":
          if (terminalEmitted) {
            return undefined;
          }
          return { type: "run-started", timestamp };
        case "message_update":
          if (terminalEmitted) {
            return undefined;
          }
          if (event.message.role === "assistant" && event.assistantMessageEvent.type === "text_delta") {
            return { type: "assistant-delta", text: event.assistantMessageEvent.delta ?? "", timestamp };
          }
          return { type: "unknown", sourceType: event.type, timestamp };
        case "tool_execution_start":
          if (terminalEmitted) {
            return undefined;
          }
          return { type: "tool-started", callId: event.toolCallId, toolName: event.toolName, input: event.args, timestamp };
        case "tool_execution_update":
          if (terminalEmitted) {
            return undefined;
          }
          return {
            type: "tool-updated",
            callId: event.toolCallId,
            ...(typeof event.partialResult === "string" ? { detail: event.partialResult } : {}),
            ...(typeof event.partialResult === "number" ? { progress: event.partialResult } : {}),
            timestamp,
          };
        case "tool_execution_end":
          if (terminalEmitted) {
            return undefined;
          }
          return { type: "tool-finished", callId: event.toolCallId, success: !event.isError, output: event.result, timestamp };
        case "agent_end":
          if (event.willRetry && context.success !== true && context.cancelled !== true) {
            return { type: "run-retrying", error: context.error ?? new Error("Agent run will retry."), timestamp };
          }
          if (terminalEmitted) {
            return undefined;
          }
          terminalEmitted = true;
          return {
            type: "run-settled",
            success: context.success ?? !context.error,
            cancelled: context.cancelled ?? false,
            ...(context.error ? { error: context.error } : {}),
            timestamp,
          };
        case "agent_settled":
          if (terminalEmitted) {
            return undefined;
          }
          terminalEmitted = true;
          return {
            type: "run-settled",
            success: context.success ?? true,
            cancelled: context.cancelled ?? false,
            ...(context.error ? { error: context.error } : {}),
            timestamp,
          };
        default:
          return { type: "unknown", sourceType: event.type, timestamp };
      }
    },
  };
}
