import path from "node:path";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { DocumentFailureReason, DocumentKind } from "./document-extract";
import { getDocumentParts, type DocumentParts } from "./document-cache";
import { numberParam, stringParam } from "./tool-params";
import { authorizeDocumentRead, DocumentAccessError, type DocumentAccessScope } from "./document-access";
export type { DocumentAccessScope } from "./document-access";

export const readDocumentToolName = "read_document";

export interface ReadDocumentToolDetails {
  readonly action: "read_document";
  readonly path: string;
  readonly kind?: DocumentKind;
  readonly part?: number;
  readonly totalParts?: number;
  readonly unit?: "page" | "section";
  readonly error?: string;
  readonly errorCode?: string;
  readonly sourceVersion?: string;
  readonly complete?: boolean;
  readonly charLimit?: number;
  readonly nextPart?: number;
}

/**
 * What one session may read.
 *
 * Resolved per tool call, never captured at registration: extensions are built
 * once per workspace and shared by every session in it, so a scope fixed at
 * registration would let any session read any other session's attachments.
 */
/** Receives the calling session's context so the scope can be narrowed to it. */
export type DocumentAccessProvider = (ctx: ExtensionContext) => DocumentAccessScope;

export function describeFailure(reason: DocumentFailureReason, detail?: string): string {
  switch (reason) {
    case "scanned-pdf":
      return (
        "This PDF has no text layer — it is a scan, so there is nothing to read. " +
        "Tell the user it cannot be read as text and suggest they attach a screenshot " +
        "of the relevant page instead, which this app can read as an image. " +
        "Do not guess at the contents."
      );
    case "password-protected":
      return "This document is password protected and cannot be opened.";
    case "corrupt":
      return `This document could not be parsed${detail ? ` (${detail})` : ""}. Tell the user the file may be damaged.`;
    case "too-large":
      return "This document is too large to read.";
    case "empty":
      return "This document is empty.";
    case "timeout":
      return "DOCUMENT_PARSE_TIMEOUT: Document parsing timed out. Retry or use a smaller document.";
    case "worker-unavailable":
      return "DOCUMENT_WORKER_UNAVAILABLE: The document worker could not run. Retry or check the application installation.";
    case "cancelled":
      return "DOCUMENT_CANCELLED: Document reading was cancelled.";
    case "queue-full":
      return "DOCUMENT_QUEUE_FULL: The document queue is full. Retry after current work completes.";
    case "changed":
      return "DOCUMENT_CHANGED: The source document changed. Search again before using a previous part locator.";
    case "unavailable":
      return "DOCUMENT_UNREADABLE: The document is temporarily unavailable or cannot be read. Retry when access is restored.";
    case "unsupported":
      return (
        "This file type cannot be read as a document. Supported types are PDF, Word (.docx), " +
        "Excel (.xlsx) and plain text. Do not fall back to the read tool for binary files — " +
        "it will return meaningless characters."
      );
  }
}

function createReadDocumentTool(getScope: DocumentAccessProvider): ToolDefinition<any, ReadDocumentToolDetails> {
  return {
    name: readDocumentToolName,
    label: "Read a document",
    description:
      "Read the text of a PDF, Word (.docx), Excel (.xlsx) or plain-text file, including files in " +
      "GBK/GB18030 encoding. Long documents are paginated — pass `part` to read further.",
    promptSnippet: "read_document: read the text of a PDF, Word, Excel or plain-text file.",
    promptGuidelines: [
      "Always use read_document instead of read for .pdf, .docx and .xlsx files. The read tool decodes them as UTF-8 and returns meaningless characters.",
      "When a document is paginated, read the parts you need before answering rather than guessing from part 1.",
      "Cite the page or sheet a fact came from, so the user can check it against the original.",
      "If the document cannot be read, say so plainly — never infer what a document you could not open probably says.",
    ],
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the document. Use the exact path given in the attachment block.",
        },
        part: {
          type: "number",
          description: "1-based page (PDF) or section number. Omit to read from the beginning.",
        },
        source_version: {
          type: "string",
          description: "Source version returned by library_search or a previous read_document. Rejects stale part locators.",
        },
      },
      required: ["path"],
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<ReadDocumentToolDetails>> {
      const target = stringParam(params, "path");
      if (!target) {
        return errorResult({ action: "read_document", path: "", error: "read_document requires a path." });
      }

      const scope = getScope(ctx);
      if (signal?.aborted) return errorResult({ action: "read_document", path: target, error: describeFailure("cancelled"), errorCode: "DOCUMENT_CANCELLED" });
      let authorized: Awaited<ReturnType<typeof authorizeDocumentRead>>;
      try {
        authorized = await authorizeDocumentRead(target, scope);
      } catch (error) {
        return errorResult({
          action: "read_document",
          path: target,
          error: error instanceof Error ? error.message : "The document cannot be read.",
          errorCode: error instanceof DocumentAccessError ? error.code : "DOCUMENT_UNREADABLE",
        });
      }

      // Served from the per-file-version cache, so paging through a long
      // standard parses it once rather than once per page turn.
      const parts = await getDocumentParts(authorized.path, { signal, expectedVersion: stringParam(params, "source_version") ?? authorized.sourceVersion });
      if (signal?.aborted) {
        return errorResult({ action: "read_document", path: target, error: describeFailure("cancelled"), errorCode: "DOCUMENT_CANCELLED" });
      }
      if ("ok" in parts) {
        return errorResult({
          action: "read_document",
          path: target,
          kind: parts.kind,
          error: describeFailure(parts.reason, parts.detail),
          errorCode: parts.code,
        });
      }

      const name = path.basename(target);
      return renderPart(target, name, parts.kind ?? "unknown", parts, numberParam(params, "part"));
    },
  };
}

function renderPart(
  target: string,
  name: string,
  kind: DocumentKind,
  document: DocumentParts,
  requested: number | undefined,
): AgentToolResult<ReadDocumentToolDetails> {
  const { unit, parts, sourceVersion, complete, charLimit } = document;
  const totalParts = parts.length;
  if (totalParts === 0) {
    return errorResult({ action: "read_document", path: target, kind, error: describeFailure("empty") });
  }
  if (requested !== undefined && (!Number.isInteger(requested) || requested < 1 || requested > totalParts)) {
    return errorResult({
      action: "read_document",
      path: target,
      kind,
      totalParts,
      unit,
      error: `This document has ${totalParts} ${unit}(s); ${requested} is out of range.`,
    });
  }

  const part = requested ?? 1;
  const body = parts[part - 1] ?? "";
  const header =
    totalParts > 1 ? `# ${name} — ${unit} ${part} of ${totalParts}\n\n` : `# ${name}\n\n`;
  // An empty page inside a text-bearing PDF is normal (a full-page figure); say
  // so explicitly so the model does not read the blank as "the clause is absent".
  const text = body || `(${unit} ${part} contains no extractable text — it may be an image.)`;
  const footer = (complete === false ? `\n\n[Partial document: extraction reached the ${charLimit ?? "safety"} character limit. Unread content may still follow. Do not claim a whole-document absence.]` : "") +
      (totalParts > part ? `\n\n[More follows — call read_document with part=${part + 1} to continue.]` : "");

  return {
    content: [{ type: "text", text: `${header}${text}${footer}\n\nSource version: ${sourceVersion ?? "unknown"}` }],
    details: { action: "read_document", path: target, kind, part, totalParts, unit, sourceVersion, complete, charLimit,
      ...(totalParts > part ? { nextPart: part + 1 } : {}) },
  };
}

export function createDocumentRuntimeTools(
  getScope: DocumentAccessProvider,
): readonly ToolDefinition<any, ReadDocumentToolDetails>[] {
  return [createReadDocumentTool(getScope)];
}

export function createDocumentRuntimeExtension(getScope: DocumentAccessProvider): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    for (const tool of createDocumentRuntimeTools(getScope)) {
      pi.registerTool(tool);
    }
  };
}

function errorResult(details: ReadDocumentToolDetails): AgentToolResult<ReadDocumentToolDetails> {
  // Returned as a normal result rather than thrown, matching the web and
  // orchestration tools: these messages ("this is a scan", "attach the file
  // first") are things the model should relay, not runtime faults.
  const message = details.error ?? "The document could not be read.";
  return {
    content: [{ type: "text", text: message }],
    details,
  };
}
