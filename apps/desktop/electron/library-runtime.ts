import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionFactory,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { numberParam, stringParam } from "./tool-params";
import type { LibraryDocument, LibraryIndexReader, LibraryIndexStatus } from "./library-index";
import { libraryDocumentIsAuthorized } from "./library-index";
import type { LibrarySettings } from "./library-store";

export const librarySearchToolName = "library_search";
export const libraryListToolName = "library_list";

export interface LibrarySearchMatch {
  readonly path: string;
  readonly title: string;
  readonly part: number;
  readonly unit: "page" | "section";
  readonly snippet: string;
  readonly matchedTerms: number;
  readonly frequency: number;
  readonly sourceVersion?: string;
  readonly complete?: boolean;
  readonly indexedAt?: string;
  readonly offline?: boolean;
}

export interface LibrarySearchToolDetails {
  readonly action: "library_search";
  readonly query: string;
  readonly results: readonly LibrarySearchMatch[];
  readonly error?: string;
}

export interface LibraryListToolDetails {
  readonly action: "library_list";
  readonly filter: string;
  readonly offset: number;
  readonly limit: number;
  readonly total: number;
  readonly documents: readonly LibraryListEntry[];
  readonly error?: string;
}

export interface LibraryListEntry {
  readonly path: string;
  readonly title: string;
  readonly unit: "page" | "section";
  readonly parts: number;
  readonly sourceVersion?: string;
  readonly complete?: boolean;
  readonly indexedAt?: string;
  readonly offline?: boolean;
}

type LibraryToolDetails = LibrarySearchToolDetails | LibraryListToolDetails;
export type LibrarySettingsProvider = () => LibrarySettings;

export function describeLibraryMisconfiguration(settings: LibrarySettings): string | undefined {
  if (!settings.enabled) {
    return "The local library is turned off. Enable it under Settings → Local library.";
  }
  if (settings.roots.length === 0) {
    return "No local library folders are configured. Add one under Settings → Local library.";
  }
  return undefined;
}

export function searchLibraryDocuments(
  documents: readonly LibraryDocument[],
  query: string,
  limit = 8,
): readonly LibrarySearchMatch[] {
  const terms = [...new Set(query.trim().toLowerCase().split(/\s+/).filter(Boolean))];
  if (terms.length === 0) {
    return [];
  }

  const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 20);
  const matches: LibrarySearchMatch[] = [];
  for (const document of documents) {
    for (const [partIndex, part] of document.parts.entries()) {
      const normalized = part.toLowerCase();
      if (!terms.every((term) => normalized.includes(term))) {
        continue;
      }
      const frequency = terms.reduce((total, term) => total + countOccurrences(normalized, term), 0);
      const firstTerm = terms.reduce((best, term) =>
        normalized.indexOf(term) < normalized.indexOf(best) ? term : best,
      );
      const firstMatch = normalized.indexOf(firstTerm);
      const match = {
        path: document.path,
        title: document.title,
        part: partIndex + 1,
        unit: document.unit,
        snippet: snippetAround(part, firstMatch, firstTerm.length, 200),
        matchedTerms: terms.length,
        frequency,
        sourceVersion: document.key, complete: document.complete,
        indexedAt: document.indexedAt, offline: document.offline,
      } satisfies LibrarySearchMatch;
      insertRankedMatch(matches, match, boundedLimit);
    }
  }
  return matches;
}

function createLibrarySearchTool(
  getSettings: LibrarySettingsProvider,
  index: LibraryIndexReader,
): ToolDefinition<any, LibraryToolDetails> {
  return {
    name: librarySearchToolName,
    label: "Search the local library",
    description:
      "Search locally indexed standards, procedures, settings, and reference documents by exact keywords. Returns matching snippets, page or section numbers, and full paths for read_document.",
    promptSnippet: "library_search: search the user's local standards and reference library.",
    promptGuidelines: libraryPromptGuidelines,
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Exact keywords to find. Multiple whitespace-separated terms use AND matching within one page or section.",
        },
        limit: {
          type: "number",
          description: "Maximum results to return. Defaults to 8 and is capped at 20.",
        },
      },
      required: ["query"],
    },
    async execute(_toolCallId, params): Promise<AgentToolResult<LibraryToolDetails>> {
      const query = stringParam(params, "query");
      if (!query) {
        return errorResult({ action: "library_search", query: "", results: [], error: "library_search requires a query." });
      }
      const settings = getSettings();
      const configurationError = describeLibraryMisconfiguration(settings);
      if (configurationError) {
        return errorResult({ action: "library_search", query, results: [], error: configurationError });
      }

      const readinessError = await refreshReadyIndex(index, settings.roots);
      if (readinessError) {
        return errorResult({ action: "library_search", query, results: [], error: readinessError });
      }

      const current = getSettings();
      const currentError = describeLibraryMisconfiguration(current);
      if (currentError) return errorResult({ action: "library_search", query, results: [], error: currentError });
      const documents = index.documents().filter((doc) => libraryDocumentIsAuthorized(doc, current.roots));
      const notice = snapshotNotice(index.status(), documents);
      const results = searchLibraryDocuments(documents, query, numberParam(params, "limit") ?? 8);
      if (results.length === 0) {
        return {
          content: [{ type: "text", text: `${notice}No local library results found for "${query}" in the indexed content. Try a synonym or a more exact standard number.` }],
          details: { action: "library_search", query, results },
        };
      }

      const text = results
        .map((result, resultIndex) => {
          const citation = result.unit === "page" ? `第 ${result.part} 页` : `第 ${result.part} 节`;
          return `${resultIndex + 1}. 《${result.title}》 ${citation}\nPath: ${result.path}\nSource version: ${result.sourceVersion}\n${result.offline ? `Offline cached source, indexed ${result.indexedAt ?? "at an unknown time"}; not freshly read.\n` : ""}${result.snippet}`;
        })
        .join("\n\n");
      return {
        content: [{ type: "text", text: notice + text }],
        details: { action: "library_search", query, results },
      };
    },
  };
}

function createLibraryListTool(
  getSettings: LibrarySettingsProvider,
  index: LibraryIndexReader,
): ToolDefinition<any, LibraryToolDetails> {
  return {
    name: libraryListToolName,
    label: "List the local library",
    description: "List documents in the user's local standards and reference library, optionally filtered by file name.",
    promptSnippet: "library_list: list documents available in the user's local library.",
    promptGuidelines: libraryPromptGuidelines,
    parameters: {
      type: "object",
      properties: {
        filter: {
          type: "string",
          description: "Optional case-insensitive file-name filter.",
        },
        offset: {
          type: "number",
          description: "Zero-based document offset. Defaults to 0.",
        },
        limit: {
          type: "number",
          description: "Maximum documents to return. Defaults to 50 and is capped at 50.",
        },
      },
    },
    async execute(_toolCallId, params): Promise<AgentToolResult<LibraryToolDetails>> {
      const filter = stringParam(params, "filter") ?? "";
      const offset = Math.max(0, Math.trunc(numberParam(params, "offset") ?? 0));
      const limit = Math.min(50, Math.max(1, Math.trunc(numberParam(params, "limit") ?? 50)));
      const settings = getSettings();
      const configurationError = describeLibraryMisconfiguration(settings);
      if (configurationError) {
        return errorResult({ action: "library_list", filter, offset, limit, total: 0, documents: [], error: configurationError });
      }

      const readinessError = await refreshReadyIndex(index, settings.roots);
      if (readinessError) {
        return errorResult({ action: "library_list", filter, offset, limit, total: 0, documents: [], error: readinessError });
      }

      const normalizedFilter = filter.toLowerCase();
      const current = getSettings();
      const currentError = describeLibraryMisconfiguration(current);
      if (currentError) return errorResult({ action: "library_list", filter, offset, limit, total: 0, documents: [], error: currentError });
      const matchingDocuments = index
        .documents()
        .filter((document) => libraryDocumentIsAuthorized(document, current.roots))
        .filter((document) => !normalizedFilter || document.title.toLowerCase().includes(normalizedFilter))
        .map((document) => ({
          path: document.path,
          title: document.title,
          unit: document.unit,
          parts: document.parts.length,
          sourceVersion: document.key, complete: document.complete,
          indexedAt: document.indexedAt, offline: document.offline,
        }));
      const documents = matchingDocuments.slice(offset, offset + limit);
      const text = documents.length
        ? documents
            .map((document, documentIndex) => {
              const unit = document.unit === "page" ? "page(s)" : "section(s)";
              return `${offset + documentIndex + 1}. 《${document.title}》 — ${document.parts} ${unit}\nPath: ${document.path}`;
            })
            .join("\n\n")
        : filter
          ? `No local library documents match "${filter}".`
          : "The local library contains no readable documents.";
      return {
        content: [{ type: "text", text: snapshotNotice(index.status(), matchingDocuments) + text }],
        details: { action: "library_list", filter, offset, limit, total: matchingDocuments.length, documents },
      };
    },
  };
}

const libraryPromptGuidelines: string[] = [
  "For questions about procedures, standards, protection settings, equipment parameters, or plant rules, search the local library before considering web_search; site documents take precedence over public information.",
  "If the first search misses, retry with synonyms or exact standard numbers (for example: 厂用电切换 / 厂用电源切换 / 厂用电源快切). Do not give up after one query.",
  "After a match, call read_document with the returned full path, part number and source_version before answering. Never answer from the search snippet alone.",
  "Cite the source as 《file name》 page N (or section N for non-paginated files).",
  "If the local library has no relevant content, say so explicitly. Never invent a clause from training memory.",
];

export function createLibraryRuntimeTools(
  getSettings: LibrarySettingsProvider,
  index: LibraryIndexReader,
): readonly ToolDefinition<any, LibraryToolDetails>[] {
  return [createLibrarySearchTool(getSettings, index), createLibraryListTool(getSettings, index)];
}

export function createLibraryRuntimeExtension(
  getSettings: LibrarySettingsProvider,
  index: LibraryIndexReader,
): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    for (const tool of createLibraryRuntimeTools(getSettings, index)) {
      pi.registerTool(tool);
    }
  };
}

async function refreshReadyIndex(index: LibraryIndexReader, roots: readonly string[]): Promise<string | undefined> {
  const status = index.status();
  if (status.state === "ready" && status.snapshotAvailable === false && status.roots?.some((root) => root.state !== "online")) {
    return "The local library is not ready: its source folders are unavailable and there is no previously committed content to search.";
  }
  if (status.state === "idle") {
    void index.rebuild(roots).catch((error) => {
      console.error("[library-runtime] background index build failed:", error);
    });
    return "The local library is not ready yet. Its documents are being prepared; try again shortly.";
  }
  if (status.state === "indexing" && !(status.snapshotAvailable ?? index.documents().length > 0)) {
    return indexingMessage(status);
  }
  return undefined;
}

function snapshotNotice(status: LibraryIndexStatus, documents: readonly { complete?: boolean; offline?: boolean }[]): string {
  return (status.state === "indexing" ? "Using the previous committed library snapshot while refresh continues.\n" : "") +
    (documents.some((doc) => doc.offline) || status.roots?.some((root) => root.state !== "online") ? "Some sources are offline or partially scanned. Cached excerpts are not a fresh reading of the source.\n" : "") +
    (documents.some((doc) => doc.complete === false) ? "Some documents are only partially indexed due to safety limits. Missing matches do not prove absence from their full text.\n" : "");
}

function insertRankedMatch(matches: LibrarySearchMatch[], match: LibrarySearchMatch, limit: number): void {
  const insertAt = matches.findIndex((current) => compareSearchMatches(match, current) < 0);
  if (insertAt < 0) {
    if (matches.length < limit) {
      matches.push(match);
    }
    return;
  }
  matches.splice(insertAt, 0, match);
  if (matches.length > limit) {
    matches.pop();
  }
}

function compareSearchMatches(left: LibrarySearchMatch, right: LibrarySearchMatch): number {
  return (
    right.matchedTerms - left.matchedTerms ||
    right.frequency - left.frequency ||
    left.title.localeCompare(right.title) ||
    left.part - right.part
  );
}

function indexingMessage(status: LibraryIndexStatus): string {
  return `The local library is still being prepared (${status.done}/${status.total}). Try again shortly.`;
}

function countOccurrences(text: string, term: string): number {
  let count = 0;
  let offset = 0;
  while (offset < text.length) {
    const found = text.indexOf(term, offset);
    if (found < 0) {
      return count;
    }
    count += 1;
    offset = found + Math.max(term.length, 1);
  }
  return count;
}

function snippetAround(text: string, matchIndex: number, matchLength: number, radius: number): string {
  const start = Math.max(0, matchIndex - radius);
  const end = Math.min(text.length, matchIndex + matchLength + radius);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

function errorResult(details: LibraryToolDetails): AgentToolResult<LibraryToolDetails> {
  return {
    content: [{ type: "text", text: details.error ?? "The local library request failed." }],
    details,
  };
}
