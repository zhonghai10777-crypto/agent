import type { SessionAttachmentExtraction } from "@pi-gui/session-driver";
import { ImageBudgetError } from "@pi-gui/session-driver/image-budget";
import type { MessageKey, Translator } from "./i18n";

/**
 * Turns an extraction result into the line shown under an attachment chip.
 *
 * Failures are surfaced with the same weight as successes on purpose: the whole
 * point of parsing documents up front is that the user learns a scan cannot be
 * read *before* they ask a question about it, rather than getting a confident
 * answer built on nothing.
 */
export interface AttachmentExtractionLabel {
  readonly key: MessageKey;
  readonly params?: Readonly<Record<string, string | number>>;
  readonly failed: boolean;
}

const FAILURE_KEYS: Readonly<Record<string, MessageKey>> = {
  "scanned-pdf": "composer.attachment.failed.scannedPdf",
  "password-protected": "composer.attachment.failed.passwordProtected",
  corrupt: "composer.attachment.failed.corrupt",
  "too-large": "composer.attachment.failed.tooLarge",
  empty: "composer.attachment.failed.empty",
  unsupported: "composer.attachment.failed.unsupported",
  unavailable: "composer.attachment.failed.unavailable",
  changed: "composer.attachment.failed.changed",
  cancelled: "composer.attachment.failed.cancelled",
  timeout: "composer.attachment.failed.timeout",
  "worker-unavailable": "composer.attachment.failed.workerUnavailable",
  "queue-full": "composer.attachment.failed.queueFull",
};

export function attachmentExtractionLabel(
  extraction: SessionAttachmentExtraction | undefined,
): AttachmentExtractionLabel | undefined {
  if (!extraction) {
    return undefined;
  }

  if (extraction.status === "failed") {
    return {
      key: FAILURE_KEYS[extraction.reason ?? ""] ?? "composer.attachment.failed.corrupt",
      failed: true,
    };
  }

  if (extraction.complete === false) {
    return { key: "composer.attachment.partial", params: { count: extraction.charLimit ?? extraction.chars ?? 0 }, failed: false };
  }
  if (extraction.pages !== undefined) {
    return { key: "composer.attachment.pages", params: { count: extraction.pages }, failed: false };
  }
  if (extraction.sheets && extraction.sheets.length > 0) {
    return { key: "composer.attachment.sheets", params: { count: extraction.sheets.length }, failed: false };
  }
  if (extraction.chars !== undefined) {
    return { key: "composer.attachment.chars", params: { count: extraction.chars }, failed: false };
  }
  return undefined;
}

/**
 * Turns an attachment-add failure into localized, actionable text for the composer
 * error banner. Known categories (image budget violations, an unreadable local
 * file) get a translated message; anything else falls back to the raw error text
 * so unmapped failures stay diagnosable instead of being silently generalized.
 */
export function describeComposerError(error: unknown, t: Translator): string {
  if (error instanceof ImageBudgetError) {
    if (error.code === "VISION_ANIMATED_IMAGE") {
      return t("composer.error.imageAnimated");
    }
    if (error.code === "VISION_IMAGE_LIMIT") {
      return t("composer.error.imageTooLarge");
    }
    return t("composer.error.imageInvalid");
  }
  if (error instanceof Error && error.message.startsWith("Could not read image:")) {
    return t("composer.error.imageReadFailed");
  }
  return error instanceof Error ? error.message : String(error);
}
