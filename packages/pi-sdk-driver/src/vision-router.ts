import { createHash, randomUUID } from "node:crypto";
import type { SessionRef } from "@pi-gui/session-driver";
import {
  VISION_MODEL_ID,
  type InspectImagesInput,
  type StoredVisionEvidence,
  type VisionCrop,
  type VisionImageBinding,
  type VisionOperationRecord,
  type VisionProgress,
  type VisionRoutingSettings,
  type VisionSessionRecord,
  type VisionUsage,
} from "@pi-gui/session-driver/vision-types";
import type { VisionApi, VisionContext, VisionImageContent, VisionMessage, VisionModel } from "./pi-compat/vision-protocol.js";
import { VisionClient, VisionRequestLimiter, type PreparedVisionImage, type VisionFetch, type VisionRequestBudget } from "./vision-client.js";
import { assertVisionActive, asVisionError, combineVisionSignal, raceVisionAbort, VisionError } from "./vision-errors.js";
import { renderVisionEvidence, VISION_PREPROCESSING_VERSION, VISION_PROMPT_VERSION } from "./vision-prompt.js";

export interface VisionPersistence {
  read(ref: SessionRef): Promise<VisionSessionRecord | undefined>;
  update(ref: SessionRef, change: (current: VisionSessionRecord) => VisionSessionRecord): Promise<VisionSessionRecord>;
  remove(ref: SessionRef): Promise<void>;
}

export interface VisionServices {
  readonly profileScopeId: string;
  readonly store: VisionPersistence;
  readonly getSettings: () => VisionRoutingSettings;
  readonly fetch: VisionFetch;
  readonly prepareImage: (
    image: VisionImageContent & { readonly imageId: string },
    settings: VisionRoutingSettings,
    signal: AbortSignal,
    crop?: VisionCrop,
  ) => Promise<PreparedVisionImage>;
}

export interface VisionSourceEntry {
  readonly id: string;
  readonly message: unknown;
}

export interface VisionSessionBinding {
  readonly ref: SessionRef;
  readonly getEntries: () => readonly VisionSourceEntry[];
  readonly imagesAllowed: () => boolean;
  readonly resolveApiKey: (model: VisionModel<VisionApi>) => Promise<string | undefined>;
  readonly onProgress: (progress: VisionProgress) => void | Promise<void>;
  readonly beforeRequest?: () => Promise<void>;
}

interface LocatedImage {
  readonly messageIndex: number;
  readonly contentIndex: number;
  readonly entryId: string;
  readonly imageIndex: number;
  readonly image: VisionImageContent;
  readonly hash: string;
  readonly question: string;
  readonly contextText: string;
}

interface RunningVisionOperation {
  readonly controller: AbortController;
  readonly generation: number;
  readonly primaryModelId: string;
  readonly sourceMessageId: string;
  readonly operationId: string;
  budget: VisionRequestBudget;
  knownUsageRequests: number;
  lastProgress?: VisionProgress;
  failure?: VisionError;
}

const TEXT_MODELS = new Set(["deepseek-v4-pro", "deepseek-v4-flash"]);

/** One canonical check for both the selected provider and resolved credentials. */
export function officialDeepSeekEndpoint(baseUrl: string): string | undefined {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" || url.hostname !== "api.deepseek.com" || url.port || url.username || url.password || url.search || url.hash) return undefined;
    if (!["", "/", "/v1", "/v1/", "/anthropic", "/anthropic/", "/anthropic/v1", "/anthropic/v1/"].includes(url.pathname)) return undefined;
    return "https://api.deepseek.com";
  } catch { return undefined; }
}

export function shouldRouteVision(model: Pick<VisionModel<VisionApi>, "id" | "baseUrl" | "input">): boolean {
  return !model.input.includes("image") && TEXT_MODELS.has(model.id) && Boolean(officialDeepSeekEndpoint(model.baseUrl));
}

export function visionHash(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function imageBytes(image: Pick<VisionImageContent, "data">, maxBytes = 10 * 1024 * 1024): Buffer {
  if (!image.data || image.data.length > Math.ceil(maxBytes / 3) * 4 + 4 || image.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) {
    throw new VisionError("VISION_IMAGE_INVALID", "The image data is invalid or exceeds the image size limit.");
  }
  const bytes = Buffer.from(image.data, "base64");
  if (!bytes.length || bytes.length > maxBytes || bytes.toString("base64") !== image.data) throw new VisionError("VISION_IMAGE_LIMIT", "The image exceeds the size limit or is not valid Base64.");
  return bytes;
}

export function validateVisionCrop(crop: VisionCrop): void {
  const values = [crop.x, crop.y, crop.width, crop.height];
  if (!values.every(Number.isFinite) || crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0 || crop.x + crop.width > 1 || crop.y + crop.height > 1) {
    throw new VisionError("VISION_IMAGE_INVALID", "The crop must be a non-empty region inside the original image, using coordinates from 0 to 1.");
  }
}

/** A bounded derived-data cache; durable bindings are read from storage independently. */
export class VisionEvidenceCache {
  private readonly entries = new Map<string, { evidence: StoredVisionEvidence; bytes: number }>();
  private bytes = 0;
  get(key: string): StoredVisionEvidence | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.evidence;
  }
  set(key: string, evidence: StoredVisionEvidence): void {
    const previous = this.entries.get(key);
    if (previous) { this.bytes -= previous.bytes; this.entries.delete(key); }
    const bytes = Buffer.byteLength(JSON.stringify(evidence));
    if (bytes > 8 * 1024 * 1024) return;
    this.entries.set(key, { evidence, bytes });
    this.bytes += bytes;
    while (this.entries.size > 64 || this.bytes > 8 * 1024 * 1024) {
      const oldest = this.entries.keys().next().value!;
      this.bytes -= this.entries.get(oldest)!.bytes;
      this.entries.delete(oldest);
    }
  }
  get size(): number { return this.entries.size; }
  get byteSize(): number { return this.bytes; }
}

export class VisionRouter {
  private readonly client: VisionClient;
  private readonly limiter = new VisionRequestLimiter();
  private readonly cache = new VisionEvidenceCache();
  private readonly active = new Map<string, RunningVisionOperation>();
  private readonly flights = new Map<string, Promise<StoredVisionEvidence>>();
  private generation = 0;

  constructor(readonly services: VisionServices) { this.client = new VisionClient(services.fetch); }

  async testConnection(apiKey: string, onRequest?: () => void): Promise<VisionUsage | undefined> {
    const settings = { ...this.services.getSettings(), maxAttempts: 1 };
    const scope = combineVisionSignal([], settings.totalTimeoutMs);
    let release: (() => void) | undefined;
    try {
      release = await this.limiter.acquire(scope.signal, settings.maxConcurrentVisionRequests);
      const image = await this.services.prepareImage({ type: "image", imageId: "img-connection-test", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAEklEQVR4nGPQSLnzHx9mGBkKAOz6mcHK/OviAAAAAElFTkSuQmCC" }, settings, scope.signal);
      const result = await this.client.recognize({ images: [image], question: "Describe the visible color of this small test image.", contextText: "Application connectivity test.", apiKey, settings, signal: scope.signal, ...(onRequest ? { onRequest } : {}), budget: { deadline: Date.now() + settings.totalTimeoutMs, attempts: 0, repairAttempted: false, largerOutputAttempted: false } });
      return result.usage;
    } finally { release?.(); scope.dispose(); }
  }

  beginTurn(ref: SessionRef, sourceMessageId: string, primaryModelId: string): void {
    this.cancel(ref);
    this.active.set(refKey(ref), this.newOperation(sourceMessageId, primaryModelId));
  }

  private newOperation(sourceMessageId: string, primaryModelId: string, generation = ++this.generation): RunningVisionOperation {
    return {
      controller: new AbortController(), generation,
      sourceMessageId, primaryModelId, operationId: randomUUID(),
      budget: { deadline: 0, attempts: 0, repairAttempted: false, largerOutputAttempted: false },
      knownUsageRequests: 0,
    };
  }

  cancel(ref: SessionRef): void {
    this.active.get(refKey(ref))?.controller.abort();
  }

  currentGeneration(ref: SessionRef): number | undefined { return this.active.get(refKey(ref))?.generation; }

  /** Also used for failures before entry binding or persistence can succeed. */
  async reportFailure(binding: VisionSessionBinding, error: unknown, primaryModelId: string, expectedGeneration?: number): Promise<void> {
    let operation = this.active.get(refKey(binding.ref));
    if (expectedGeneration !== undefined && operation?.generation !== expectedGeneration) return;
    if (!operation) {
      operation = this.newOperation(binding.getEntries().at(-1)?.id ?? "unaccepted", primaryModelId);
      this.active.set(refKey(binding.ref), operation);
    }
    const failure = asVisionError(error);
    if (operation.lastProgress?.errorCode === failure.code && ["failed", "cancelled"].includes(operation.lastProgress.stage)) return;
    operation.failure = failure;
    await this.progress(binding, operation, {
      stage: failure.code === "VISION_CANCELLED" ? "cancelled" : "failed", retryable: failure.code !== "VISION_CANCELLED",
      errorCode: failure.code, errorMessage: failure.message,
    }).catch(() => {});
  }

  async settle(binding: VisionSessionBinding, completed: boolean): Promise<void> {
    const operation = this.active.get(refKey(binding.ref));
    if (!operation?.lastProgress || ["failed", "cancelled", "interrupted"].includes(operation.lastProgress.stage)) return;
    await this.progress(binding, operation, { stage: completed ? "completed" : "failed", retryable: !completed });
  }

  async recover(ref: SessionRef): Promise<VisionProgress | undefined> {
    const record = await this.services.store.read(ref);
    if (!record) return undefined;
    this.generation = record.operations.reduce((latest, operation) => Math.max(latest, operation.generation), this.generation);
    const unfinished = record.operations.some((op) => ["waiting", "recognizing", "persisting", "answering"].includes(op.stage));
    const current = unfinished ? await this.persist(ref, (data) => ({
      ...data,
      operations: data.operations.map((op) => ["waiting", "recognizing", "persisting", "answering"].includes(op.stage)
        ? { ...op, stage: "interrupted", retryable: true, errorCode: "VISION_INTERRUPTED", errorMessage: "The previous run was interrupted. Retry explicitly; the primary model may already have received the request.", updatedAt: new Date().toISOString() }
        : op),
    })) : record;
    return current.operations.at(-1);
  }

  async project(model: VisionModel<VisionApi>, context: VisionContext, binding: VisionSessionBinding, signal?: AbortSignal): Promise<VisionContext> {
    assertVisionActive(signal);
    if (model.input.includes("image")) return context;
    if (!binding.imagesAllowed() && context.messages.some((message) => Array.isArray(message.content) && message.content.some((part) => part.type === "text" && part.text === "Image reading is disabled."))) {
      // Pi applies this global policy in convertToLlm, before streamFunction.
      throw new VisionError("VISION_DISABLED", "Image reading is disabled in the runtime settings.");
    }
    const hasImages = context.messages.some((message) => Array.isArray(message.content) && message.content.some((part) => part.type === "image"));
    if (!hasImages) {
      assertTextOnlyPayload(context);
      return this.appendImageDirectory(context, binding);
    }
    if (!binding.imagesAllowed()) {
      throw new VisionError("VISION_DISABLED", "Image reading is disabled in the runtime settings.");
    }
    if (!shouldRouteVision(model)) throw new VisionError("VISION_UNSUPPORTED_PROVIDER", "This text model cannot read images. Select an image-capable model or an official DeepSeek Pro/Flash provider.");
    if (!this.services.getSettings().enabled) throw new VisionError("VISION_DISABLED", "Enable automatic image analysis in Settings or choose an image-capable model.");
    const located = locateImages(context, binding.getEntries(), this.services.getSettings());
    const existing = await this.services.store.read(binding.ref);
    const latest = located.at(-1)!;
    const sourceId = existing?.images.find((image) => image.sourceMessageEntryId === latest.entryId)?.clientMessageId ?? latest.entryId;
    let operation = this.active.get(refKey(binding.ref));
    if (!operation || operation.sourceMessageId !== sourceId && operation.lastProgress?.stage === "completed") {
      operation = this.newOperation(sourceId, model.id);
      this.active.set(refKey(binding.ref), operation);
    }
    if (operation.failure) throw operation.failure;
    // A primary/tool run may last much longer than a vision request. Reading
    // already-persisted evidence has no network budget to exhaust.
    const scope = combineVisionSignal([signal, operation.controller.signal]);
    const currentOperation = operation;
    const assertCurrent = () => {
      assertVisionActive(scope.signal);
      if (this.active.get(refKey(binding.ref)) !== currentOperation) throw new VisionError("VISION_CANCELLED", "A newer turn replaced this image analysis.");
    };
    try {
      assertCurrent();
      const bindings = await this.bindImages(binding.ref, located, existing);
      assertCurrent();
      const records = await this.services.store.read(binding.ref);
      assertCurrent();
      const evidenceById = new Map((records?.evidence ?? []).map((evidence) => [evidence.evidenceId, evidence]));
      const results = new Map<string, StoredVisionEvidence>();
      const missing: VisionImageBinding[] = [];
      for (const image of bindings) {
        const evidence = image.evidenceId ? evidenceById.get(image.evidenceId) : undefined;
        if (evidence && evidence.providerId === model.provider && evidence.endpointIdentity === officialDeepSeekEndpoint(model.baseUrl) && evidence.promptVersion === VISION_PROMPT_VERSION && evidence.body.images.some((entry) => entry.imageId === image.imageId)) results.set(image.imageId, evidence);
        else missing.push(image);
      }
      if (missing.length) {
        await this.progress(binding, operation, { stage: "waiting", imageCount: bindings.length, completedImages: bindings.length - missing.length });
        assertCurrent();
        // Keep each original multi-image input together and its first question frozen.
        const groups = new Map<string, VisionImageBinding[]>();
        for (const image of missing) {
          const group = groups.get(image.inputDigest) ?? [];
          group.push(image);
          groups.set(image.inputDigest, group);
        }
        for (const group of groups.values()) {
          const sources = group.map((image) => ({ binding: image, source: located.find((source) => source.entryId === image.sourceMessageEntryId && source.imageIndex === image.imageIndex)! }));
          const result = await this.recognize(model, binding, operation, sources, scope.signal);
          assertCurrent();
          for (const image of group) results.set(image.imageId, result);
          await this.progress(binding, operation, { completedImages: results.size });
          assertCurrent();
        }
      }
      assertCurrent();
      const replacements = new Map<string, string>();
      for (let i = 0; i < located.length; i += 1) {
        const source = located[i]!;
        const image = bindings[i]!;
        const evidence = results.get(image.imageId);
        if (!evidence) throw new VisionError("VISION_STORAGE", "An image has no durable evidence. Retry image analysis.", true);
        replacements.set(`${source.messageIndex}:${source.contentIndex}`, renderVisionEvidence({
          ...evidence.body,
          images: evidence.body.images.filter((entry) => entry.imageId === image.imageId),
        }));
      }
      const messages = context.messages.map((message, index) => {
        if (!Array.isArray(message.content) || message.role === "assistant") return message;
        return { ...message, content: message.content.map((part, contentIndex) => {
          const text = replacements.get(`${index}:${contentIndex}`);
          return text === undefined ? part : { type: "text" as const, text };
        }) };
      });
      const projected = { ...context, messages };
      assertTextOnlyPayload(projected);
      await this.progress(binding, operation, { stage: "answering", completedImages: bindings.length, evidenceIds: [...new Set([...results.values()].map((evidence) => evidence.evidenceId))] });
      assertCurrent();
      return projected;
    } catch (error) {
      const failure = asVisionError(error);
      operation.failure = failure;
      if (this.active.get(refKey(binding.ref)) === operation) {
        await this.progress(binding, operation, {
          stage: failure.code === "VISION_CANCELLED" ? "cancelled" : "failed",
          retryable: failure.code !== "VISION_CANCELLED",
          errorCode: failure.code,
          errorMessage: failure.message,
        }).catch(() => {});
      }
      throw failure;
    } finally { scope.dispose(); }
  }

  async projectSummary(model: VisionModel<VisionApi>, context: VisionContext, binding: VisionSessionBinding, signal: AbortSignal): Promise<VisionContext> {
    const key = refKey(binding.ref);
    const parent = this.active.get(key);
    const operation = this.newOperation(binding.getEntries().at(-1)?.id ?? "summary", model.id, parent?.generation);
    this.active.set(key, operation);
    try {
      const result = await this.project(model, context, binding, signal);
      await this.settle(binding, true);
      return result;
    } catch (error) {
      await this.reportFailure(binding, error, model.id, operation.generation);
      throw error;
    } finally {
      if (this.active.get(key) === operation) {
        if (parent) this.active.set(key, parent); else this.active.delete(key);
      }
    }
  }

  private async bindImages(ref: SessionRef, sources: readonly LocatedImage[], previous: VisionSessionRecord | undefined): Promise<VisionImageBinding[]> {
    const bindings = sources.map((source) => {
      const saved = previous?.images.find((entry) => entry.sourceMessageEntryId === source.entryId && entry.imageIndex === source.imageIndex && entry.imageHash === source.hash);
      if (saved) return saved;
      const submission = previous?.submissions.find((entry) => entry.sourceMessageEntryId === source.entryId);
      const siblings = sources.filter((entry) => entry.entryId === source.entryId);
      const inputDigest = visionHash(JSON.stringify({
        profile: this.services.profileScopeId, ref, entry: source.entryId,
        hashes: siblings.map((entry) => entry.hash), question: source.question, context: source.contextText,
        model: VISION_MODEL_ID, endpoint: "https://api.deepseek.com", prompt: VISION_PROMPT_VERSION,
        schema: 1, preprocessing: VISION_PREPROCESSING_VERSION,
      }));
      return {
        imageId: `img-${visionHash(JSON.stringify([this.services.profileScopeId, ref, source.entryId, source.imageIndex, source.hash])).slice(0, 24)}`,
        sourceMessageEntryId: source.entryId, imageIndex: source.imageIndex, imageHash: source.hash,
        question: source.question, contextText: source.contextText, inputDigest,
        generation: submission?.generation ?? 0,
        ...(submission ? { clientMessageId: submission.clientMessageId } : {}),
      };
    });
    if (bindings.some((entry) => !previous?.images.some((saved) => saved.imageId === entry.imageId))) {
      await this.persist(ref, (record) => ({ ...record, images: mergeBy(record.images, bindings, (entry) => entry.imageId) }));
    }
    return bindings;
  }

  private async recognize(
    model: VisionModel<VisionApi>, binding: VisionSessionBinding, operation: RunningVisionOperation,
    images: readonly { binding: VisionImageBinding; source: LocatedImage }[], signal: AbortSignal,
    question = images[0]!.binding.question, crop?: VisionCrop, force = false,
  ): Promise<StoredVisionEvidence> {
    const digest = visionHash(JSON.stringify([images.map((image) => image.binding.inputDigest), model.provider, model.id, question, crop ?? null]));
    const key = `${refKey(binding.ref)}:${digest}`;
    const flightKey = `${key}:${operation.generation}`;
    if (!force) {
      const flight = this.flights.get(flightKey);
      if (flight) return raceVisionAbort(flight, signal);
    }
    const work = (async () => {
      if (!force) {
        const record = await this.services.store.read(binding.ref);
        assertVisionActive(signal);
        const saved = record?.evidence.find((entry) => entry.inputDigest === digest &&
          entry.providerId === model.provider && entry.endpointIdentity === officialDeepSeekEndpoint(model.baseUrl) &&
          entry.promptVersion === VISION_PROMPT_VERSION && entry.preprocessingVersion === VISION_PREPROCESSING_VERSION);
        if (saved) {
          const cached = this.cache.get(key);
          const evidence = cached?.evidenceId === saved.evidenceId ? cached : saved;
          // Switching provider configurations can move an image's current
          // evidence pointer. Restore its durable binding when reusing an older
          // result, so the same evidence remains available after a restart.
          await this.persist(binding.ref, (current) => ({ ...current, images: current.images.map((image) =>
            images.some((entry) => entry.binding.imageId === image.imageId) ? { ...image, evidenceId: evidence.evidenceId } : image) }));
          assertVisionActive(signal);
          this.cache.set(key, evidence);
          return evidence;
        }
      }
      const settings = this.services.getSettings();
      // Start the budget at the first recognition, then share it across all
      // missing history, tool-loop images and SDK re-entry in this turn.
      // Only an explicit retry or a distinct inspect_images call starts anew.
      if (!operation.budget.deadline) operation.budget = { ...operation.budget, deadline: Date.now() + settings.totalTimeoutMs };
      const budget = operation.budget;
      const scope = combineVisionSignal([signal], budget.deadline - Date.now());
      signal = scope.signal;
      let release: (() => void) | undefined;
      try {
        release = await this.limiter.acquire(signal, settings.maxConcurrentVisionRequests);
        assertVisionActive(signal);
        const apiKey = await raceVisionAbort(binding.resolveApiKey(model), signal);
        if (!apiKey) throw new VisionError("VISION_AUTH", "Configure credentials for the selected official DeepSeek provider.");
        await this.progress(binding, operation, { stage: "recognizing" });
        const prepared: PreparedVisionImage[] = [];
        for (const image of images) {
          prepared.push(await raceVisionAbort(this.services.prepareImage({ ...image.source.image, imageId: image.binding.imageId }, settings, signal, crop), signal));
        }
        const result = await this.client.recognize({
          images: prepared, question, contextText: images[0]!.binding.contextText, apiKey, settings,
          budget, signal,
          onAttempt: async () => { await this.progress(binding, operation, { stage: "recognizing" }); },
          onRequest: async () => {
            await this.progress(binding, operation, { requests: (operation.lastProgress?.requests ?? 0) + 1, usageUnknown: true });
          },
          onUsage: async (usage) => {
            assertVisionActive(signal);
            if (usage?.inputTokens !== undefined && usage.outputTokens !== undefined) operation.knownUsageRequests += 1;
            await this.progress(binding, operation, {
              usageUnknown: operation.knownUsageRequests < (operation.lastProgress?.requests ?? 0),
              ...(usage ? { usage: addVisionUsage(operation.lastProgress?.usage, usage) } : {}),
            });
          },
        });
        assertVisionActive(signal);
        const evidence: StoredVisionEvidence = {
          version: 1, evidenceId: randomUUID(), operationId: operation.operationId,
          profileScopeId: this.services.profileScopeId, sessionRef: binding.ref,
          sourceMessageEntryIds: [...new Set(images.map((image) => image.source.entryId))],
          imageHashes: images.map((image) => image.source.hash), inputDigest: digest,
          providerId: model.provider, endpointIdentity: officialDeepSeekEndpoint(model.baseUrl)!,
          modelId: VISION_MODEL_ID, promptVersion: VISION_PROMPT_VERSION, preprocessingVersion: VISION_PREPROCESSING_VERSION,
          createdAt: new Date().toISOString(), body: result.body,
          ...(result.usage ? { usage: result.usage } : {}),
        };
        await this.progress(binding, operation, { stage: "persisting" });
        assertVisionActive(signal);
        await this.persist(binding.ref, (record) => ({
          ...record,
          evidence: [...record.evidence, evidence],
          images: record.images.map((image) => !force && images.some((entry) => entry.binding.imageId === image.imageId)
            ? { ...image, evidenceId: evidence.evidenceId } : image),
        }));
        assertVisionActive(signal);
        this.cache.set(key, evidence);
        return evidence;
      } finally { release?.(); scope.dispose(); }
    })();
    this.flights.set(flightKey, work);
    try { return await work; } finally { if (this.flights.get(flightKey) === work) this.flights.delete(flightKey); }
  }

  async inspect(model: VisionModel<VisionApi>, binding: VisionSessionBinding, input: InspectImagesInput, signal?: AbortSignal): Promise<StoredVisionEvidence> {
    if (!shouldRouteVision(model) || !this.services.getSettings().enabled || !binding.imagesAllowed()) throw new VisionError("VISION_DISABLED", "Image inspection requires enabled image analysis and the selected official DeepSeek text model.");
    if (!input.question.trim() || input.question.length > 16_384 || !input.imageIds.length || input.imageIds.length > 8 || new Set(input.imageIds).size !== input.imageIds.length) throw new VisionError("VISION_REQUEST", "Provide a question and one to eight distinct authorized image IDs.");
    if (input.crop) validateVisionCrop(input.crop);
    const record = await this.services.store.read(binding.ref);
    const sources = locateImages({ messages: binding.getEntries().map((entry) => entry.message as VisionMessage) }, binding.getEntries(), this.services.getSettings());
    const images = input.imageIds.map((id) => {
      const image = record?.images.find((entry) => entry.imageId === id);
      const source = image && sources.find((entry) => entry.entryId === image.sourceMessageEntryId && entry.imageIndex === image.imageIndex && entry.hash === image.imageHash);
      if (!image || !source) throw new VisionError("VISION_UNAUTHORIZED_IMAGE", "This image is not available in the active session branch.");
      return { binding: image, source };
    });
    const parent = this.active.get(refKey(binding.ref));
    const operation = this.newOperation(parent?.sourceMessageId ?? images[0]!.binding.clientMessageId ?? images[0]!.source.entryId, model.id, parent?.generation);
    const scope = combineVisionSignal([signal, parent?.controller.signal, operation.controller.signal]);
    try {
      await this.progress(binding, operation, { stage: "waiting", imageCount: images.length });
      const evidence = await this.recognize(model, binding, operation, images, scope.signal, input.question, input.crop, true);
      assertVisionActive(scope.signal);
      await this.progress(binding, operation, { stage: "completed", completedImages: images.length, evidenceIds: [evidence.evidenceId] });
      return evidence;
    } catch (error) {
      const failure = asVisionError(error);
      await this.progress(binding, operation, { stage: failure.code === "VISION_CANCELLED" ? "cancelled" : "failed", retryable: true, errorCode: failure.code, errorMessage: failure.message }).catch(() => {});
      throw failure;
    } finally { scope.dispose(); }
  }

  async fork(source: SessionRef, target: SessionRef, entries: readonly VisionSourceEntry[]): Promise<void> {
    const original = await this.services.store.read(source);
    if (!original) return;
    const entryIds = new Set(entries.map((entry) => entry.id));
    const images = original.images.filter((image) => entryIds.has(image.sourceMessageEntryId));
    const imageIds = new Set(images.map((image) => image.imageId));
    const evidence = original.evidence.filter((item) => item.sourceMessageEntryIds.every((id) => entryIds.has(id)) && item.body.images.every((image) => imageIds.has(image.imageId))).map((item) => ({ ...item, sessionRef: target }));
    await this.persist(target, (record) => ({ ...record, images, evidence, submissions: original.submissions.filter((submission) => submission.sourceMessageEntryId && entryIds.has(submission.sourceMessageEntryId)) }));
  }

  private async appendImageDirectory(context: VisionContext, binding: VisionSessionBinding): Promise<VisionContext> {
    if (!binding.imagesAllowed()) return context;
    const record = await this.services.store.read(binding.ref);
    if (!record?.images.length) return context;
    const entries = new Set(binding.getEntries().map((entry) => entry.id));
    const images = record.images.filter((image) => entries.has(image.sourceMessageEntryId) && image.evidenceId);
    if (!images.length) return context;
    // Add the directory at an existing user data position, never a fabricated turn or system instruction.
    let index = context.messages.length - 1;
    while (index >= 0 && context.messages[index]?.role !== "user") index -= 1;
    if (index < 0) return context;
    const message = context.messages[index]!;
    const directory = `[Available image source IDs in this branch: ${images.map((image) => image.imageId).join(", ")}. Use inspect_images for details not present in the evidence.]`;
    return { ...context, messages: context.messages.map((entry, i) => i !== index ? entry : {
      ...message, content: [...(typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content), { type: "text" as const, text: directory }],
    } as VisionMessage) };
  }

  private async progress(binding: VisionSessionBinding, operation: RunningVisionOperation, change: Partial<VisionProgress>): Promise<void> {
    const now = new Date().toISOString();
    const progress: VisionProgress = {
      operationId: operation.operationId, sessionId: binding.ref.sessionId, sourceMessageId: operation.sourceMessageId,
      generation: operation.generation, stage: "waiting", imageCount: 0, completedImages: 0,
      primaryModelId: operation.primaryModelId, visionModelId: VISION_MODEL_ID,
      ...operation.lastProgress, ...change,
      revision: (operation.lastProgress?.revision ?? 0) + 1,
    };
    // Publish actionable failures even when disk permissions also prevent their
    // durable record. Successful handoff still requires the write to complete.
    operation.lastProgress = progress;
    const terminal = ["failed", "cancelled", "interrupted"].includes(progress.stage);
    if (!terminal) assertVisionActive(operation.controller.signal);
    let record: VisionSessionRecord;
    try { record = await this.persist(binding.ref, (data) => {
      const previous = data.operations.find((entry) => entry.operationId === operation.operationId);
      const entry: VisionOperationRecord = { ...progress, ...operation.budget, createdAt: previous?.createdAt ?? now, updatedAt: now };
      return { ...data, operations: mergeBy(data.operations, [entry], (item) => item.operationId) };
    }); } catch (error) {
      if (terminal) await binding.onProgress(progress);
      throw error;
    }
    operation.lastProgress = record.operations.find((entry) => entry.operationId === operation.operationId)!;
    await binding.onProgress(operation.lastProgress);
  }

  private async persist(ref: SessionRef, change: (record: VisionSessionRecord) => VisionSessionRecord): Promise<VisionSessionRecord> {
    try { return await this.services.store.update(ref, change); }
    catch { throw new VisionError("VISION_STORAGE", "Image evidence could not be saved. The original message is retained; check disk permissions and retry.", true); }
  }
}

export function emptyVisionSession(profileScopeId: string, ref: SessionRef): VisionSessionRecord {
  return { version: 1, profileScopeId, sessionRef: { ...ref }, images: [], evidence: [], operations: [], submissions: [] };
}

export function addVisionUsage(a: VisionUsage | undefined, b: VisionUsage): VisionUsage {
  return Object.fromEntries((["inputTokens", "outputTokens", "cachedInputTokens"] as const).flatMap((key) => b[key] === undefined && a?.[key] === undefined ? [] : [[key, (a?.[key] ?? 0) + (b[key] ?? 0)]]));
}

function mergeBy<T>(old: readonly T[], next: readonly T[], key: (entry: T) => string): T[] {
  const values = new Map(old.map((entry) => [key(entry), entry]));
  for (const entry of next) values.set(key(entry), entry);
  return [...values.values()];
}

function refKey(ref: SessionRef): string { return JSON.stringify([ref.workspaceId, ref.sessionId]); }

function textOf(message: unknown): string {
  const content = (message as { content?: unknown })?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

export function visionMessageSignature(message: unknown): string {
  const source = message as { role?: string; timestamp?: number; toolCallId?: string; content?: unknown };
  return visionHash(JSON.stringify([source.role, source.timestamp, source.toolCallId, source.content]));
}

function locateImages(context: VisionContext, entries: readonly VisionSourceEntry[], settings: VisionRoutingSettings): LocatedImage[] {
  const sources: LocatedImage[] = [];
  const bySignature = new Map<string, VisionSourceEntry[]>();
  for (const entry of entries) {
    const signature = visionMessageSignature(entry.message);
    const values = bySignature.get(signature) ?? [];
    values.push(entry);
    bySignature.set(signature, values);
  }
  context.messages.forEach((message, messageIndex) => {
    if ((message.role !== "user" && message.role !== "toolResult") || !Array.isArray(message.content)) return;
    const images = message.content.filter((part) => part.type === "image");
    if (!images.length) return;
    if (images.length > settings.maxImagesPerMessage) throw new VisionError("VISION_IMAGE_LIMIT", "A message can contain at most eight images.");
    const entry = bySignature.get(visionMessageSignature(message))?.shift();
    if (!entry) throw new VisionError("VISION_UNAUTHORIZED_IMAGE", "The image is not bound to an original message in this session branch.");
    let total = 0;
    let imageIndex = 0;
    const latestQuestion = context.messages.slice(0, messageIndex + 1).reverse().find((item) => item.role === "user");
    const question = textOf(latestQuestion).replace(/^<pi-gui-file-attachments>[\s\S]*?<\/pi-gui-file-attachments>\n?/, "").slice(0, 16_384);
    // Do not copy assistant/tool/document history or the system prompt into a separate service.
    const contextText = message.role === "toolResult" ? `Screenshot from tool ${message.toolName}.` : "";
    message.content.forEach((part, contentIndex) => {
      if (part.type !== "image") return;
      const bytes = imageBytes(part, settings.maxImageBytes);
      total += bytes.length;
      if (total > settings.maxMessageImageBytes) throw new VisionError("VISION_IMAGE_LIMIT", "The total image size in this message is too large.");
      sources.push({ messageIndex, contentIndex, entryId: entry.id, imageIndex: imageIndex++, image: part, hash: visionHash(bytes), question, contextText });
    });
  });
  return sources;
}

/** Inspect protocol content positions, never arbitrary business keys inside tool arguments. */
export function assertTextOnlyPayload(payload: unknown): void {
  if (!payload || typeof payload !== "object") return;
  const root = payload as Record<string, unknown>;
  const messages = Array.isArray(root.messages) ? root.messages : Array.isArray(root.input) ? root.input : [];
  const inlineImage = /data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]{24,}/i;
  const inspectBlock = (block: unknown): void => {
    if (typeof block === "string") {
      if (inlineImage.test(block)) throw new VisionError("VISION_PAYLOAD", "An inline image payload remained in a text-model request.");
      return;
    }
    if (!block || typeof block !== "object") return;
    const part = block as Record<string, unknown>;
    if (["image", "image_url", "input_image"].includes(String(part.type))) throw new VisionError("VISION_PAYLOAD", "An image content block remained in a text-model request.");
    if (part.type === "file" || part.type === "input_file") {
      const file = part.file && typeof part.file === "object" ? part.file as Record<string, unknown> : part;
      const encoded = JSON.stringify(file);
      const mime = String(file.mime_type ?? file.mimeType ?? file.media_type ?? "");
      const name = String(file.filename ?? file.name ?? file.file_url ?? file.url ?? "");
      // Untyped opaque file IDs cannot establish that a text model can read the
      // referenced file. Keep explicit non-image document blocks compatible.
      if (/image\/|data:image/i.test(encoded) || /\.(?:png|jpe?g|gif|webp)(?:[?#]|$)/i.test(name) || file.file_id && !mime && !/\.(?:pdf|txt|csv|json|md)$/i.test(name)) throw new VisionError("VISION_PAYLOAD", "An image or untyped file reference remained in a text-model request.");
    }
    if (part.type === "text" || part.type === "input_text" || part.type === "output_text") inspectBlock(part.text);
  };
  inspectBlock(root.input);
  for (const raw of messages) {
    inspectBlock(raw);
    if (!raw || typeof raw !== "object") continue;
    const message = raw as Record<string, unknown>;
    const blocks = Array.isArray(message.content) ? message.content : [message.content];
    for (const block of blocks) inspectBlock(block);
  }
}
