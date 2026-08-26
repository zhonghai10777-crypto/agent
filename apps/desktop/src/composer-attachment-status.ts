import type { SessionAttachmentExtraction } from "@pi-gui/session-driver";
import type { MessageKey } from "./i18n";

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
