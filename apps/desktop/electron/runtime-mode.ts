import type { RuntimeCapability, RuntimeCapabilitySnapshot, RuntimeMode } from "../src/desktop-state";

export type { RuntimeCapability } from "../src/desktop-state";

export type RuntimeCapabilityPolicy = RuntimeCapabilitySnapshot;

export function policyForRuntimeMode(mode: RuntimeMode): RuntimeCapabilityPolicy {
  return mode === "agent"
    ? {
        terminal: true,
        worktrees: true,
        fileMutation: true,
        officeMutation: true,
        shellExecution: true,
        childAgents: true,
        extensions: true,
      }
    : {
        terminal: false,
        worktrees: false,
        fileMutation: false,
        officeMutation: true,
        shellExecution: false,
        childAgents: false,
        extensions: false,
      };
}

export function assertRuntimeCapability(mode: RuntimeMode, capability: RuntimeCapability): void {
  if (!policyForRuntimeMode(mode)[capability]) {
    throw new Error(`Capability '${capability}' is unavailable in light mode. Switch to Agent mode and restart the app.`);
  }
}
