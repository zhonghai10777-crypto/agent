import {
  VISION_ENDPOINT,
  VISION_MODEL_ID,
  type VisionEvidenceBody,
  type VisionRoutingSettings,
  type VisionUsage,
} from "@pi-gui/session-driver/vision-types";
import { assertVisionActive, asVisionError, combineVisionSignal, raceVisionAbort, VisionError } from "./vision-errors.js";
import { MAX_EVIDENCE_BYTES, parseVisionEvidence, VISION_SYSTEM_PROMPT } from "./vision-prompt.js";

export interface PreparedVisionImage {
  readonly imageId: string;
  readonly mimeType: string;
  readonly data: string;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
}

/** Kept by the route, not recreated by an SDK retry/continue. */
export interface VisionRequestBudget {
  readonly deadline: number;
  attempts: number;
  repairAttempted: boolean;
  largerOutputAttempted: boolean;
}

export interface VisionClientInput {
  readonly images: readonly PreparedVisionImage[];
  readonly question: string;
  readonly contextText: string;
  readonly apiKey: string;
  readonly settings: VisionRoutingSettings;
  readonly budget: VisionRequestBudget;
  readonly signal: AbortSignal;
  readonly onAttempt?: (budget: VisionRequestBudget) => Promise<void>;
  readonly onRequest?: () => void | Promise<void>;
  readonly onUsage?: (usage: VisionUsage | undefined) => Promise<void>;
}

export type VisionFetch = typeof globalThis.fetch;

/** One gate per service/process. A cancelled waiter never acquires a future slot. */
export class VisionRequestLimiter {
  private active = 0;
  private readonly waiting: Array<{ acquire(): void; signal: AbortSignal; abort(): void }> = [];

  async acquire(signal: AbortSignal, concurrency = 1): Promise<() => void> {
    assertVisionActive(signal);
    if (this.active >= concurrency) {
      await new Promise<void>((resolve, reject) => {
        const waiter = {
          signal,
          acquire: resolve,
          abort: () => {
            const index = this.waiting.indexOf(waiter);
            if (index >= 0) this.waiting.splice(index, 1);
            try { assertVisionActive(signal); } catch (error) { reject(error); }
          },
        };
        signal.addEventListener("abort", waiter.abort, { once: true });
        this.waiting.push(waiter);
      });
    } else {
      this.active += 1;
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) {
        next.signal.removeEventListener("abort", next.abort);
        next.acquire();
      } else {
        this.active -= 1;
      }
    };
    if (signal.aborted) {
      release();
      assertVisionActive(signal);
    }
    return release;
  }
}

export class VisionClient {
  constructor(private readonly fetchImpl: VisionFetch, private readonly now = Date.now) {}

  async recognize(input: VisionClientInput): Promise<{ body: VisionEvidenceBody; usage?: VisionUsage }> {
    const { settings, budget, signal } = input;
    if (!input.apiKey.trim()) throw new VisionError("VISION_AUTH", "Configure authentication for the selected DeepSeek provider.");
    if (!input.images.length || input.images.length > settings.maxImagesPerMessage) {
      throw new VisionError("VISION_IMAGE_LIMIT", "Too many images in one image analysis request.");
    }
    let maxTokens = settings.maxOutputTokens;
    let repair = false;
    while (true) {
      assertVisionActive(signal);
      if (this.now() >= budget.deadline) throw new VisionError("VISION_TIMEOUT", "Image analysis exceeded its time budget.", true);
      if (budget.attempts >= settings.maxAttempts) throw new VisionError("VISION_BUDGET", "Image analysis exhausted its retry budget. Retry the message.", true);
      const body = JSON.stringify({
        model: VISION_MODEL_ID,
        thinking: { type: "disabled" },
        stream: false,
        response_format: { type: "json_object" },
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: VISION_SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: `Question: ${input.question.slice(0, 16_384)}\nLimited context: ${input.contextText.slice(0, 16_384)}${repair ? "\nThe prior response was invalid. Return every required field and exactly the supplied image IDs in valid JSON." : ""}` },
              ...input.images.flatMap((image) => [
                { type: "text", text: `Image ID: ${image.imageId}` },
                { type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.data}`, detail: "original" } },
              ]),
            ],
          },
        ],
      });
      if (Buffer.byteLength(body, "utf8") > settings.maxRequestBodyBytes) {
        throw new VisionError("VISION_IMAGE_LIMIT", "The serialized image request is too large. Reduce the number or size of images.");
      }
      budget.attempts += 1;
      await input.onAttempt?.(budget);
      assertVisionActive(signal);
      const attempt = combineVisionSignal([signal], Math.min(settings.attemptTimeoutMs, budget.deadline - this.now()));
      let failure: VisionError;
      try {
        const pendingResponse = raceVisionAbort(this.fetchImpl(VISION_ENDPOINT, {
          method: "POST",
          headers: { Authorization: `Bearer ${input.apiKey}`, "Content-Type": "application/json" },
          body,
          signal: attempt.signal,
          redirect: "error",
        }), attempt.signal);
        // Record attempted HTTP requests even if the connection later fails or
        // is cancelled and the server's usage can no longer be determined.
        void pendingResponse.catch(() => {});
        await input.onRequest?.();
        const response = await pendingResponse;
        if (!response.ok) {
          await response.body?.cancel();
          throw classifyVisionHttpError(response.status, response.headers.get("retry-after"), this.now());
        }
        const payload = await readResponse(response, attempt.signal);
        assertVisionActive(signal);
        const usage = readVisionUsage(payload.usage);
        await input.onUsage?.(usage);
        assertVisionActive(signal);
        const choices = payload.choices;
        if (!Array.isArray(choices) || choices.length !== 1) throw invalidResponse();
        const choice = record(choices[0]);
        const finishReason = choice.finish_reason;
        if (finishReason === "length") throw new VisionError("VISION_TRUNCATED", "Image evidence was truncated. Use fewer images or crop the relevant region.", true);
        if (finishReason === "content_filter") throw new VisionError("VISION_FILTERED", "The image service declined to process this content.");
        if (finishReason !== "stop") throw invalidResponse();
        const message = record(choice.message);
        if (typeof message.content !== "string" || message.tool_calls !== undefined) throw invalidResponse();
        const evidence = parseVisionEvidence(message.content, input.images.map((image) => image.imageId));
        assertVisionActive(signal);
        return { body: evidence, ...(usage ? { usage } : {}) };
      } catch (error) {
        assertVisionActive(signal);
        failure = attempt.signal.aborted && attempt.signal.reason instanceof VisionError
          ? attempt.signal.reason
          : asVisionError(error);
      } finally {
        attempt.dispose();
      }
      if (failure.code === "VISION_INVALID_RESPONSE" && !budget.repairAttempted) {
        budget.repairAttempted = true;
        repair = true;
      } else if (failure.code === "VISION_TRUNCATED" && !budget.largerOutputAttempted) {
        budget.largerOutputAttempted = true;
        maxTokens = Math.min(16_384, Math.max(maxTokens * 2, 16_384));
      } else if (!["VISION_NETWORK", "VISION_RATE_LIMIT", "VISION_TIMEOUT"].includes(failure.code) || !failure.retryable) {
        throw failure;
      }
      if (budget.attempts >= settings.maxAttempts) throw failure;
      const delayMs = failure.retryAfterMs ?? Math.min(1000 * 2 ** (budget.attempts - 1), 5000);
      if (this.now() + delayMs >= budget.deadline) throw failure;
      await visionDelay(delayMs, signal);
    }
  }
}

function invalidResponse(): VisionError {
  return new VisionError("VISION_INVALID_RESPONSE", "The image service returned an empty or incomplete response.", true);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResponse();
  return value as Record<string, unknown>;
}

async function readResponse(response: Response, signal: AbortSignal): Promise<Record<string, unknown>> {
  const limit = MAX_EVIDENCE_BYTES + 128 * 1024;
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw invalidResponse();
  }
  const reader = response.body?.getReader();
  if (!reader) throw invalidResponse();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await raceVisionAbort(reader.read(), signal);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw invalidResponse();
      chunks.push(value);
    }
    try { return record(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { throw invalidResponse(); }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function readVisionUsage(value: unknown): VisionUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>;
  const count = (name: string) => typeof usage[name] === "number" && Number.isSafeInteger(usage[name]) && (usage[name] as number) >= 0 ? usage[name] as number : undefined;
  const inputTokens = count("prompt_tokens");
  const outputTokens = count("completion_tokens");
  const cachedInputTokens = count("prompt_cache_hit_tokens");
  if (inputTokens === undefined && outputTokens === undefined && cachedInputTokens === undefined) return undefined;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
  };
}

export function classifyVisionHttpError(status: number, retryAfter: string | null, now = Date.now()): VisionError {
  if (status === 401 || status === 403) return new VisionError("VISION_AUTH", "DeepSeek authentication was rejected. Check the selected provider's credentials.");
  if (status === 402) return new VisionError("VISION_ACCOUNT", "DeepSeek reported an account or balance restriction.");
  if (status === 404) return new VisionError("VISION_MODEL_UNAVAILABLE", "The selected account cannot access the auxiliary vision model.");
  let delay: number | undefined;
  if (retryAfter) {
    const raw = Number(retryAfter);
    const parsed = Number.isFinite(raw) ? raw * 1000 : Date.parse(retryAfter) - now;
    if (Number.isFinite(parsed)) delay = Math.max(0, Math.min(parsed, 180_000));
  }
  if (status === 429) return new VisionError("VISION_RATE_LIMIT", "DeepSeek temporarily limited image requests.", true, delay);
  if ([500, 502, 503, 504].includes(status)) return new VisionError("VISION_NETWORK", "DeepSeek image processing is temporarily unavailable.", true, delay);
  return new VisionError("VISION_REQUEST", "DeepSeek rejected the image request. Check the model and image format.");
}

export async function visionDelay(ms: number, signal: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await raceVisionAbort(new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); }), signal);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
