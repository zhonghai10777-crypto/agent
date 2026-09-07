import type { VisionErrorCode } from "@pi-gui/session-driver/vision-types";

/** Error text is application-owned: never attach provider bodies, OCR or credentials. */
export class VisionError extends Error {
  constructor(
    readonly code: VisionErrorCode,
    message: string,
    readonly retryable = false,
    readonly retryAfterMs?: number,
  ) {
    super(`${code}: ${message}`);
    this.name = "VisionError";
  }
}

export function abortVisionError(): VisionError {
  return new VisionError("VISION_CANCELLED", "Image analysis was cancelled.");
}

export function assertVisionActive(signal?: AbortSignal): void {
  if (signal?.aborted) {
    if (signal.reason instanceof VisionError) throw signal.reason;
    throw abortVisionError();
  }
}

export function asVisionError(error: unknown): VisionError {
  if (error instanceof VisionError) return error;
  if (error instanceof Error && error.name === "AbortError") return abortVisionError();
  return new VisionError("VISION_NETWORK", "The image service could not be reached. Try again.", true);
}

/** Also bounds transports/workers that fail to observe their AbortSignal. */
export async function raceVisionAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  assertVisionActive(signal);
  let listener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    listener = () => {
      try { assertVisionActive(signal); } catch (error) { reject(error); }
    };
    signal.addEventListener("abort", listener, { once: true });
  });
  try {
    const result = await Promise.race([work, aborted]);
    assertVisionActive(signal);
    return result;
  } finally {
    if (listener) signal.removeEventListener("abort", listener);
  }
}

export function combineVisionSignal(signals: readonly (AbortSignal | undefined)[], timeoutMs?: number): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const listeners: Array<readonly [AbortSignal, () => void]> = [];
  for (const signal of signals) {
    if (!signal) continue;
    const abort = () => controller.abort(signal.reason instanceof VisionError ? signal.reason : abortVisionError());
    if (signal.aborted) abort();
    else {
      signal.addEventListener("abort", abort, { once: true });
      listeners.push([signal, abort]);
    }
  }
  const timeout = () => controller.abort(new VisionError("VISION_TIMEOUT", "Image analysis exceeded its time budget.", true));
  const timer = timeoutMs === undefined ? undefined : setTimeout(timeout, Math.max(0, timeoutMs));
  if (timeoutMs !== undefined && timeoutMs <= 0) timeout();
  timer?.unref?.();
  return {
    signal: controller.signal,
    dispose() {
      if (timer) clearTimeout(timer);
      for (const [signal, listener] of listeners) signal.removeEventListener("abort", listener);
    },
  };
}
