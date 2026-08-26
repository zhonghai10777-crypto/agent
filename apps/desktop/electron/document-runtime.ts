import path from "node:path";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { DocumentFailureReason, DocumentKind } from "./document-extract";
import { getDocumentExtraction, getDocumentParts } from "./document-cache";
import { numberParam, stringParam } from "./tool-params";

export const readDocumentToolName = "read_document";

export interface ReadDocumentToolDetails {
  readonly action: "read_document";
  readonly path: string;
  readonly kind?: DocumentKind;
  readonly part?: number;
  readonly totalParts?: number;
  readonly unit?: "page" | "section";
  readonly error?: string;
}

/**
 * What one session may read.
 *
 * Resolved per tool call, never captured at registration: extensions are built
 * once per workspace and shared by every session in it, so a scope fixed at
 * registration would let any session read any other session's attachments.
 */
export interface DocumentAccessScope {
  /** Directories the model may read documents from. */
  readonly workspaceRoots: readonly string[];
  /** Files attached to this conversation, which routinely live outside any workspace. */
  readonly allowedFiles: readonly string[];
}

/** Receives the calling session's context so the scope can be narrowed to it. */
export type DocumentAccessProvider = (ctx: ExtensionContext) => DocumentAccessScope;

/**
 * A path is in scope when it is one of the files attached to this conversation,
 * or sits under a workspace root. Resolved and normalized before comparison so
 * `..` traversal cannot walk out of a root.
 */
export function isPathInScope(target: string, scope: DocumentAccessScope): boolean {
  const resolved = path.resolve(target);
  if (scope.allowedFiles.some((file) => path.resolve(file) === resolved)) {
    return true;
  }
  return scope.workspaceRoots.some((root) => {
    const resolvedRoot = path.resolve(root);
    const relative = path.relative(resolvedRoot, resolved);
    // path.relative returns "" for the root itself and a ".."-prefixed path for
    // anything above it; an absolute result means a different drive on Windows.
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  });
}

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
      },
      required: ["path"],
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<ReadDocumentToolDetails>> {
      const target = stringParam(params, "path");
      if (!target) {
        return errorResult({ action: "read_document", path: "", error: "read_document requires a path." });
      }

      const scope = getScope(ctx);
      if (!isPathInScope(target, scope)) {
        return errorResult({
          action: "read_document",
          path: target,
          error:
            "That file is outside the current workspace and was not attached to this conversation, " +
            "so it cannot be read. Ask the user to attach it.",
        });
      }

      // Served from the per-file-version cache, so paging through a long
      // standard parses it once rather than once per page turn.
      const parts = await getDocumentParts(target);
      if (signal?.aborted) {
        return errorResult({ action: "read_document", path: target, error: "Cancelled." });
      }
      if ("ok" in parts) {
        return errorResult({
          action: "read_document",
          path: target,
          kind: parts.kind,
          error: describeFailure(parts.reason, parts.detail),
        });
      }

      const name = path.basename(target);
      const kind = (await getDocumentExtraction(target)).kind;
      return renderPart(target, name, kind, parts.unit, parts.parts, numberParam(params, "part"));
    },
  };
}

function renderPart(
  target: string,
  name: string,
  kind: DocumentKind,
  unit: "page" | "section",
  parts: readonly string[],
  requested: number | undefined,
): AgentToolResult<ReadDocumentToolDetails> {
  const totalParts = parts.length;
  if (totalParts === 0) {
    return errorResult({ action: "read_document", path: target, kind, error: describeFailure("empty") });
  }
  if (requested !== undefined && (requested < 1 || requested > totalParts)) {
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
  const footer =
    totalParts > part
      ? `\n\n[More follows — call read_document with part=${part + 1} to continue.]`
      : "";

  return {
    content: [{ type: "text", text: `${header}${text}${footer}` }],
    details: { action: "read_document", path: target, kind, part, totalParts, unit },
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
