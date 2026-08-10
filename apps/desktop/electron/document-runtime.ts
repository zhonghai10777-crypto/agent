import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI, ExtensionFactory, ToolDefinition, AgentToolResult } from "@earendil-works/pi-coding-agent";
import {
  extractDocument,
  extractPdfPages,
  segmentText,
  sniffDocumentKind,
  type DocumentFailureReason,
  type DocumentKind,
} from "./document-extract";

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
 * Read at call time rather than registration time so a newly attached file is
 * reachable immediately, matching how the web tools pick up settings changes.
 */
export interface DocumentAccessScope {
  /** Directories the model may read documents from. */
  readonly workspaceRoots: readonly string[];
  /** Individual files the user attached, which routinely live outside any workspace. */
  readonly allowedFiles: readonly string[];
}

export type DocumentAccessProvider = () => DocumentAccessScope;

/**
 * Files the user attached during this app session.
 *
 * Attachments routinely live outside every workspace (a standard downloaded to
 * ~/Downloads), and the composer draft that carried them is cleared the moment
 * the message is sent — which is just before the model actually goes to read
 * them. Recording the path at the attachment chokepoint keeps it readable for
 * the rest of the session without widening the tool to "any path on disk".
 */
const attachedDocuments = new Set<string>();
const MAX_REMEMBERED_ATTACHMENTS = 500;

export function rememberAttachedDocument(fsPath: string): void {
  const resolved = path.resolve(fsPath);
  // Re-inserting moves the entry to the end of the Set's iteration order, so
  // the eviction below drops the least recently attached file.
  attachedDocuments.delete(resolved);
  attachedDocuments.add(resolved);
  while (attachedDocuments.size > MAX_REMEMBERED_ATTACHMENTS) {
    const oldest = attachedDocuments.values().next();
    if (oldest.done) {
      break;
    }
    attachedDocuments.delete(oldest.value);
  }
}

export function attachedDocumentPaths(): readonly string[] {
  return [...attachedDocuments];
}

/** Test seam: drops the remembered attachments. */
export function resetAttachedDocuments(): void {
  attachedDocuments.clear();
}

/** Keeps a single tool result well inside the context window. */
const SECTION_CHARS = 4_000;

/**
 * A path is in scope when it is one of the files the user attached, or sits
 * under a workspace root. Resolved and normalized before comparison so
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
    async execute(_toolCallId, params, signal): Promise<AgentToolResult<ReadDocumentToolDetails>> {
      const target = stringParam(params, "path");
      if (!target) {
        return errorResult({ action: "read_document", path: "", error: "read_document requires a path." });
      }

      const scope = getScope();
      if (!isPathInScope(target, scope)) {
        return errorResult({
          action: "read_document",
          path: target,
          error:
            "That file is outside the current workspace and was not attached to this conversation, " +
            "so it cannot be read. Ask the user to attach it.",
        });
      }

      let buffer: Uint8Array;
      try {
        buffer = new Uint8Array(await readFile(target));
      } catch (error) {
        return errorResult({ action: "read_document", path: target, error: errorMessage(error) });
      }
      if (signal?.aborted) {
        return errorResult({ action: "read_document", path: target, error: "Cancelled." });
      }

      const name = path.basename(target);
      const kind = sniffDocumentKind(buffer, name);
      const requested = numberParam(params, "part");

      if (kind === "pdf") {
        const pages = await extractPdfPages(buffer);
        if ("ok" in pages) {
          return errorResult({
            action: "read_document",
            path: target,
            kind,
            error: describeFailure(pages.reason, pages.detail),
          });
        }
        return renderPart(target, name, kind, "page", pages.pages, requested);
      }

      const extraction = await extractDocument(buffer, name);
      if (!extraction.ok) {
        return errorResult({
          action: "read_document",
          path: target,
          kind: extraction.kind,
          error: describeFailure(extraction.reason, extraction.detail),
        });
      }
      const sections = segmentText(extraction.text, SECTION_CHARS);
      return renderPart(target, name, extraction.kind, "section", sections, requested);
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringParam(params: unknown, key: string): string | undefined {
  if (typeof params !== "object" || params === null) {
    return undefined;
  }
  const value = (params as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberParam(params: unknown, key: string): number | undefined {
  if (typeof params !== "object" || params === null) {
    return undefined;
  }
  const value = (params as Record<string, unknown>)[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  // Models routinely send numeric arguments as strings.
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }
  return undefined;
}
