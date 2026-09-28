import type { ExtensionAPI, ExtensionFactory, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { readDocumentToolName } from "./document-runtime";
import { officeToolNames } from "./office-runtime";
import { composeMutatingToolNames, composeToolNames } from "./office-compose";

/**
 * Desktop tools whose `sourcePath` argument identifies a file the model read
 * before acting on it (word_template_inspect never writes; the others also
 * write, tracked separately below).
 */
const READ_SOURCE_PATH_TOOLS: ReadonlySet<string> = new Set([
  ...officeToolNames.filter((name) => name !== "word_create" && name !== "excel_create"),
  ...composeToolNames.filter((name) => name !== "word_compose"),
]);

/**
 * Desktop tools whose successful (non-error) result carries an output path in
 * `details.outputPath` — see `runOfficeWrite`'s `OfficeWriteResult` in
 * office-runtime.ts.
 */
const WRITE_TOOLS: ReadonlySet<string> = new Set([...officeToolNames, ...composeMutatingToolNames]);

export interface DesktopFileOps {
  readonly read: readonly string[];
  readonly written: readonly string[];
}

/**
 * Pure extraction of desktop-tool file operations from a batch of
 * AgentMessages (assistant tool calls and their toolResult messages), for
 * merging into pi's own compaction fileOps. Mirrors pi's built-in
 * `extractFileOpsFromMessage` (compaction/utils.ts) for its native
 * read/write/edit tools, extended here for this app's `read_document`,
 * `word_*`/`excel_*`, `word_compose` and `word_template_*` tools.
 *
 * Reads come from the assistant's tool-call *arguments* (`path`/`sourcePath`),
 * regardless of whether the call succeeded — matching pi's own convention,
 * where "did the model attempt to read this file" is what matters for
 * `<read-files>`.
 *
 * Writes come from the toolResult's *details*, not `isError`: `runOfficeWrite`
 * (office-runtime.ts) always returns a normal, non-thrown result even on
 * failure — a rejected write's details are `{ error }` with no `outputPath`,
 * while a successful write's details are an `OfficeWriteResult` whose
 * `outputPath` is always present. So `outputPath` presence is the real
 * success signal for these tools, not `isError` (S3.2).
 */
export function collectDesktopFileOps(messages: readonly unknown[]): DesktopFileOps {
  const read = new Set<string>();
  const written = new Set<string>();
  for (const message of messages) {
    if (typeof message !== "object" || message === null) {
      continue;
    }
    const role = (message as { role?: unknown }).role;
    if (role === "assistant") {
      collectReadsFromAssistantMessage(message as { content?: unknown }, read);
    } else if (role === "toolResult") {
      collectWriteFromToolResult(message as { toolName?: unknown; details?: unknown }, written);
    }
  }
  return { read: [...read].sort(), written: [...written].sort() };
}

function collectReadsFromAssistantMessage(message: { content?: unknown }, read: Set<string>): void {
  const content = message.content;
  if (!Array.isArray(content)) {
    return;
  }
  for (const block of content) {
    if (typeof block !== "object" || block === null) {
      continue;
    }
    const { type, name, arguments: args } = block as { type?: unknown; name?: unknown; arguments?: unknown };
    if (type !== "toolCall" || typeof name !== "string" || typeof args !== "object" || args === null) {
      continue;
    }
    const params = args as Record<string, unknown>;
    if (name === readDocumentToolName) {
      addIfPath(read, params.path);
    } else if (READ_SOURCE_PATH_TOOLS.has(name)) {
      addIfPath(read, params.sourcePath);
    }
  }
}

function collectWriteFromToolResult(message: { toolName?: unknown; details?: unknown }, written: Set<string>): void {
  const { toolName, details } = message;
  if (typeof toolName !== "string" || !WRITE_TOOLS.has(toolName)) {
    return;
  }
  if (typeof details !== "object" || details === null) {
    return;
  }
  addIfPath(written, (details as { outputPath?: unknown }).outputPath);
}

function addIfPath(set: Set<string>, value: unknown): void {
  if (typeof value === "string" && value) {
    set.add(value);
  }
}

/**
 * Extension that folds desktop tool file operations into pi's own compaction
 * fileOps before the summary is generated, so this app's read/write tools —
 * which pi's own file-op tracking does not know about — show up in the
 * summary's `<read-files>`/`<modified-files>` the same way pi's built-in
 * read/write/edit tools do.
 *
 * Mutates `event.preparation.fileOps` in place and returns nothing: it never
 * cancels or replaces the compaction, and cannot conflict with another
 * extension's `session_before_compact` handler for the same event (S3.3) —
 * notably the vision extension's, which only projects image content in
 * `messagesToSummarize`/`turnPrefixMessages` and never touches `fileOps`.
 */
export function createCompactionFileOpsExtension(): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.on("session_before_compact", (event: SessionBeforeCompactEvent) => {
      const { fileOps, messagesToSummarize, turnPrefixMessages } = event.preparation;
      const ops = collectDesktopFileOps([...messagesToSummarize, ...turnPrefixMessages]);
      for (const path of ops.read) {
        fileOps.read.add(path);
      }
      for (const path of ops.written) {
        fileOps.written.add(path);
      }
    });
  };
}
