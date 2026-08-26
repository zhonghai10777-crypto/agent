import type { RuntimeMode } from "../src/desktop-state";

export type RuntimeCapability =
  | "terminal"
  | "worktrees"
  | "fileMutation"
  | "shellExecution"
  | "childAgents"
  | "extensions";

export interface RuntimeCapabilityPolicy {
  readonly terminal: boolean;
  readonly worktrees: boolean;
  readonly fileMutation: boolean;
  readonly shellExecution: boolean;
  readonly childAgents: boolean;
  readonly extensions: boolean;
}

export function policyForRuntimeMode(mode: RuntimeMode): RuntimeCapabilityPolicy {
  return mode === "agent"
    ? {
        terminal: true,
        worktrees: true,
        fileMutation: true,
        shellExecution: true,
        childAgents: true,
        extensions: true,
      }
    : {
        terminal: false,
        worktrees: false,
        fileMutation: false,
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
