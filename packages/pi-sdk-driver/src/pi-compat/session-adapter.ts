import { SessionManager, createAgentSession, type CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import type { CompatAgentSessionOptions, CompatAgentSessionRuntime } from "./runtime-factory.js";
import { createAgentSessionRuntime } from "./runtime-factory.js";

export function createCompatSession(options: CompatAgentSessionOptions): Promise<CompatAgentSessionRuntime> {
  return createAgentSessionRuntime(options);
}

export function createOneShotSession(options: CreateAgentSessionOptions) {
  return createAgentSession(options);
}

export function createSessionManager(cwd: string): SessionManager {
  return SessionManager.create(cwd);
}

export function createInMemorySessionManager(): SessionManager {
  return SessionManager.inMemory();
}

export function openSessionManager(sessionFile: string): SessionManager {
  return SessionManager.open(sessionFile);
}

export function forkSessionManager(sessionFile: string, targetCwd: string): SessionManager {
  return SessionManager.forkFrom(sessionFile, targetCwd);
}

export function listSessions(cwd: string) {
  return SessionManager.list(cwd);
}
