import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { SessionMessageInput } from "@pi-gui/session-driver";
import type { VisionSubmission } from "@pi-gui/session-driver/vision-types";
import { officialDeepSeekEndpoint, visionHash, visionMessageSignature, type VisionPersistence, type VisionSourceEntry } from "../vision-router.js";
import { VisionError } from "../vision-errors.js";
import { resolveModelAuth } from "./auth-adapter.js";
import type { VisionApi, VisionModel } from "./vision-protocol.js";
import { PI_RUNTIME_VERSION } from "./version.js";

export function visionSessionEntries(session: AgentSession): VisionSourceEntry[] {
  return session.sessionManager.getBranch().flatMap((entry) => entry.type === "message" ? [{ id: entry.id, message: entry.message }] : []);
}

export async function resolveVisionSessionKey(session: AgentSession, model: VisionModel<VisionApi>): Promise<string | undefined> {
  return resolveVisionModelKey(session.modelRuntime, model);
}

export async function resolveVisionModelKey(runtime: ModelRuntime, model: VisionModel<VisionApi>): Promise<string | undefined> {
  const configured = runtime.getModel(model.provider, model.id);
  const endpoint = officialDeepSeekEndpoint(model.baseUrl);
  if (!configured || !endpoint || officialDeepSeekEndpoint(configured.baseUrl) !== endpoint) throw new VisionError("VISION_UNSUPPORTED_PROVIDER", "The selected model is not bound to an official DeepSeek provider configuration.");
  const auth = await resolveModelAuth(runtime, configured);
  return auth?.auth.apiKey;
}

export function visionInputDigest(input: SessionMessageInput): string {
  return digest(input.text, input.attachments?.flatMap((attachment) => attachment.kind === "image" ? [attachment.data] : []) ?? []);
}

function digest(text: string, images: readonly string[]): string {
  return visionHash(JSON.stringify([text.trim(), images.map((data) => visionHash(Buffer.from(data, "base64")))]));
}

export function visionMessageInputDigest(message: unknown): string | undefined {
  const value = message as { role?: string; content?: string | Array<{ type: string; text?: string; data?: string }> };
  if (value.role !== "user") return undefined;
  const content = value.content;
  const text = (typeof content === "string" ? content : content?.flatMap((part) => part.type === "text" ? [part.text ?? ""] : []).join("\n") ?? "").replace(/^<pi-gui-file-attachments>[\s\S]*?<\/pi-gui-file-attachments>\n?/, "");
  const images = Array.isArray(content) ? content.flatMap((part) => part.type === "image" ? [part.data ?? ""] : []) : [];
  return digest(text, images);
}

/** Entry IDs are learned from Pi's persisted branch, never assumed equal to optimistic UI IDs. */
export async function syncVisionMessageEntries(session: AgentSession, store: VisionPersistence, ref: { workspaceId: string; sessionId: string }): Promise<void> {
  const record = await store.read(ref);
  if (!record?.submissions.some((submission) => submission.state === "pending")) return;
  const branch = session.sessionManager.getBranch();
  await store.update(ref, (data) => {
    const used = new Set(data.submissions.flatMap((submission) => submission.sourceMessageEntryId ? [submission.sourceMessageEntryId] : []));
    const submissions = data.submissions.map((submission): VisionSubmission => {
      if (submission.state !== "pending") return submission;
      const after = submission.afterEntryId ? branch.findIndex((entry) => entry.id === submission.afterEntryId) : -1;
      const entry = branch.find((item, index) => index > after && item.type === "message" && !used.has(item.id) && visionMessageInputDigest(item.message) === submission.inputDigest);
      if (!entry) return submission;
      used.add(entry.id);
      return { ...submission, sourceMessageEntryId: entry.id, state: "accepted" };
    });
    return { ...data, submissions };
  });
}

export function annotateVisionMessageSources(manager: AgentSession["sessionManager"], messages: readonly unknown[]): unknown[] {
  const entries = new Map<string, string[]>();
  for (const entry of manager.getBranch()) {
    if (entry.type !== "message") continue;
    const signature = visionMessageSignature(entry.message);
    const ids = entries.get(signature) ?? [];
    ids.push(entry.id);
    entries.set(signature, ids);
  }
  return messages.map((message) => {
    const sourceMessageEntryId = entries.get(visionMessageSignature(message))?.shift();
    return sourceMessageEntryId ? { ...(message as object), sourceMessageEntryId } : message;
  });
}

/**
 * Pi 0.84.4 has no public AgentSession.continue. Its verified internal runner
 * accepts an empty prompt list and retains all normal post-run retries,
 * compaction, queue draining and isStreaming/isIdle transitions. The public
 * agent.continue alone would bypass those AgentSession lifecycle guarantees.
 * No messages or JSONL entries are removed, and no synthetic user turn is added.
 */
export async function continueAcceptedVisionTurn(session: AgentSession): Promise<void> {
  const compat = session as unknown as { _runAgentPrompt?: (messages: readonly never[]) => Promise<void> };
  if (PI_RUNTIME_VERSION !== "0.84.4" || typeof compat._runAgentPrompt !== "function") throw new VisionError("VISION_REQUEST", "This runtime version does not support continuing an accepted image message.");
  await compat._runAgentPrompt.call(session, []);
}
