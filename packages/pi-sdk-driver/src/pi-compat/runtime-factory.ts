import { ModelRegistry, ModelRuntime, type AgentSessionRuntime, type CreateModelRuntimeOptions } from "@earendil-works/pi-coding-agent";
import {
  createAgentSessionRuntimeWithNpmFallback,
  type PiCreateAgentSessionOptions,
} from "../npm-package-fallback.js";

export function createModelRuntime(options: CreateModelRuntimeOptions = {}): Promise<ModelRuntime> {
  return ModelRuntime.create(options);
}

export function createModelRegistry(runtime: ModelRuntime): ModelRegistry {
  return new ModelRegistry(runtime);
}

export type CompatAgentSessionOptions = PiCreateAgentSessionOptions;
export type CompatAgentSessionRuntime = AgentSessionRuntime;

export function createAgentSessionRuntime(
  options?: CompatAgentSessionOptions,
): Promise<AgentSessionRuntime> {
  return createAgentSessionRuntimeWithNpmFallback(options);
}
