import type { SessionRef } from "./types.js";

export const VISION_MODEL_ID = "deepseek-v4-flash-vision-exp" as const;
export const VISION_ENDPOINT = "https://api.deepseek.com/chat/completions" as const;

export interface VisionRoutingSettings {
  readonly version: 1;
  readonly enabled: boolean;
  readonly policy: "fallback-for-text-model";
  readonly source: "same-official-provider";
  readonly targetModelId: typeof VISION_MODEL_ID;
  readonly onFailure: "block-and-offer-retry";
  readonly maxImagesPerMessage: number;
  readonly maxImageBytes: number;
  readonly maxMessageImageBytes: number;
  readonly maxRequestBodyBytes: number;
  readonly maxImageDimension: number;
  readonly maxImagePixels: number;
  readonly maxConcurrentVisionRequests: number;
  readonly attemptTimeoutMs: number;
  readonly totalTimeoutMs: number;
  readonly maxAttempts: number;
  readonly maxOutputTokens: number;
}

export const DEFAULT_VISION_ROUTING_SETTINGS: VisionRoutingSettings = Object.freeze({
  version: 1,
  enabled: true,
  policy: "fallback-for-text-model",
  source: "same-official-provider",
  targetModelId: VISION_MODEL_ID,
  onFailure: "block-and-offer-retry",
  maxImagesPerMessage: 8,
  maxImageBytes: 10 * 1024 * 1024,
  maxMessageImageBytes: 20 * 1024 * 1024,
  maxRequestBodyBytes: 32 * 1024 * 1024,
  maxImageDimension: 8192,
  maxImagePixels: 20_000_000,
  maxConcurrentVisionRequests: 1,
  attemptTimeoutMs: 60_000,
  totalTimeoutMs: 180_000,
  maxAttempts: 3,
  maxOutputTokens: 8192,
});

export type VisionQuality = "complete" | "partial" | "unreadable";

export interface VisionEvidenceBody {
  readonly schemaVersion: 1;
  readonly images: readonly {
    readonly imageId: string;
    readonly quality: VisionQuality;
    readonly summary: string;
    readonly extractedText: string;
    readonly observations: readonly string[];
    readonly tables: readonly {
      readonly title: string;
      readonly headers: readonly string[];
      readonly rows: readonly (readonly (string | null)[])[];
    }[];
    readonly uncertainties: readonly string[];
  }[];
  readonly crossImageObservations: readonly string[];
}

export interface VisionUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedInputTokens?: number;
}

export interface StoredVisionEvidence {
  readonly version: 1;
  readonly evidenceId: string;
  readonly operationId: string;
  readonly profileScopeId: string;
  readonly sessionRef: SessionRef;
  readonly sourceMessageEntryIds: readonly string[];
  readonly imageHashes: readonly string[];
  readonly inputDigest: string;
  readonly providerId: string;
  readonly endpointIdentity: string;
  readonly modelId: string;
  readonly promptVersion: string;
  readonly preprocessingVersion: string;
  readonly createdAt: string;
  readonly body: VisionEvidenceBody;
  readonly usage?: VisionUsage;
}

export type VisionErrorCode =
  | "VISION_DISABLED" | "VISION_UNSUPPORTED_PROVIDER" | "VISION_AUTH"
  | "VISION_ACCOUNT" | "VISION_MODEL_UNAVAILABLE" | "VISION_REQUEST"
  | "VISION_RATE_LIMIT" | "VISION_NETWORK" | "VISION_TIMEOUT"
  | "VISION_INVALID_RESPONSE" | "VISION_TRUNCATED" | "VISION_FILTERED"
  | "VISION_IMAGE_INVALID" | "VISION_IMAGE_LIMIT" | "VISION_ANIMATED_IMAGE"
  | "VISION_STORAGE" | "VISION_CANCELLED" | "VISION_INTERRUPTED"
  | "VISION_UNAUTHORIZED_IMAGE" | "VISION_PAYLOAD" | "VISION_BUDGET";

export type VisionStage =
  | "waiting" | "recognizing" | "persisting" | "answering"
  | "completed" | "failed" | "cancelled" | "interrupted";

export interface VisionProgress {
  readonly operationId: string;
  readonly sessionId: string;
  readonly sourceMessageId: string;
  readonly generation: number;
  readonly stage: VisionStage;
  readonly imageCount: number;
  readonly completedImages: number;
  readonly primaryModelId: string;
  readonly visionModelId: string;
  readonly retryable?: boolean;
  readonly errorCode?: VisionErrorCode;
  readonly errorMessage?: string;
  readonly evidenceIds?: readonly string[];
  readonly usage?: VisionUsage;
  readonly requests?: number;
  readonly usageUnknown?: boolean;
}

export interface VisionOperationRecord extends VisionProgress {
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deadline: number;
  readonly attempts: number;
  readonly repairAttempted: boolean;
  readonly largerOutputAttempted: boolean;
}

/** Metadata only. Original image bytes remain in the Pi session/attachment store. */
export interface VisionImageBinding {
  readonly imageId: string;
  readonly sourceMessageEntryId: string;
  readonly clientMessageId?: string;
  readonly imageIndex: number;
  readonly imageHash: string;
  readonly question: string;
  readonly contextText: string;
  readonly inputDigest: string;
  readonly generation: number;
  readonly evidenceId?: string;
}

export interface VisionSubmission {
  readonly clientMessageId: string;
  readonly inputDigest: string;
  readonly generation: number;
  readonly sourceMessageEntryId?: string;
  readonly state: "pending" | "accepted" | "completed";
}

export interface VisionSessionRecord {
  readonly version: 1;
  readonly profileScopeId: string;
  readonly sessionRef: SessionRef;
  readonly images: readonly VisionImageBinding[];
  readonly evidence: readonly StoredVisionEvidence[];
  readonly operations: readonly VisionOperationRecord[];
  readonly submissions: readonly VisionSubmission[];
}

export interface VisionCrop {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface InspectImagesInput {
  readonly imageIds: readonly string[];
  readonly question: string;
  readonly crop?: VisionCrop;
}

export interface VisionSessionView {
  readonly progress: readonly VisionProgress[];
  readonly images: readonly Pick<VisionImageBinding, "imageId" | "sourceMessageEntryId" | "clientMessageId" | "imageIndex" | "evidenceId">[];
  readonly usage?: VisionUsage;
  readonly requests: number;
  readonly usageUnknown: boolean;
}
