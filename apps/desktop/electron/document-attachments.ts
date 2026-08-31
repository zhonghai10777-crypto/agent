import type { SessionAttachment, SessionAttachmentExtraction } from "@pi-gui/session-driver";
import type { ComposerAttachment } from "../src/desktop-state";
import type { DocumentExtraction } from "./document-extract";
import { getDocumentExtraction } from "./document-cache";

/**
 * Bridges extraction results onto attachments, at the two points that need it:
 * attach time (so the chip can report pages and surface failures before the
 * user sends) and submit time (so short documents ride into the prompt).
 */

/**
 * Documents at or under this size are inlined into the prompt so a simple
 * question is answered without a tool round-trip. Anything larger is left to
 * read_document, which pages — inlining a 300-page standard would burn the
 * context window on every subsequent turn of the conversation.
 */
export const INLINE_DOCUMENT_CHAR_LIMIT = 20_000;

export function toAttachmentExtraction(extraction: DocumentExtraction): SessionAttachmentExtraction {
  if (!extraction.ok) {
    return { status: "failed", reason: extraction.reason };
  }
  return {
    status: "ok",
    chars: extraction.text.length,
    ...(extraction.meta.pages !== undefined ? { pages: extraction.meta.pages } : {}),
    ...(extraction.meta.sheets ? { sheets: extraction.meta.sheets } : {}),
    ...(extraction.meta.encoding ? { encoding: extraction.meta.encoding } : {}),
    ...(extraction.meta.truncated ? { truncated: true } : {}),
  };
}

/**
 * Parses file attachments as they are added, so the chip can report "12 pages"
 * and — more importantly — a scan or an unreadable file is called out before
 * the user sends a question about it.
 */
export async function withExtractionMetadata(
  attachments: readonly ComposerAttachment[],
): Promise<ComposerAttachment[]> {
  const result: ComposerAttachment[] = [];
  for (const attachment of attachments) {
    if (attachment.kind !== "file") {
      result.push(attachment);
      continue;
    }
    result.push({ ...attachment, extraction: toAttachmentExtraction(await getDocumentExtraction(attachment.fsPath)) });
  }
  return result;
}

/**
 * Resolves extraction for every file attachment on the submit path. Images pass
 * through untouched — they already have a working multimodal path.
 */
export async function withDocumentText(
  attachments: readonly SessionAttachment[],
): Promise<readonly SessionAttachment[]> {
  if (attachments.length === 0) {
    return attachments;
  }
  const result: SessionAttachment[] = [];
  for (const attachment of attachments) {
    if (attachment.kind !== "file") {
      result.push(attachment);
      continue;
    }
    const extraction = await getDocumentExtraction(attachment.fsPath);
    const summary = toAttachmentExtraction(extraction);
    const inline = extraction.ok && extraction.text.length <= INLINE_DOCUMENT_CHAR_LIMIT;
    result.push({
      ...attachment,
      extraction: summary,
      ...(inline && extraction.ok ? { documentText: extraction.text } : {}),
    });
  }
  return result;
}
