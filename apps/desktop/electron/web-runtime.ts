import type { ExtensionAPI, ExtensionFactory, ToolDefinition, AgentToolResult } from "@earendil-works/pi-coding-agent";
import {
  describeWebToolsMisconfiguration,
  isHostAllowed,
  runWebFetch,
  runWebSearch,
  type WebSearchResult,
  type WebToolsSettings,
} from "./web-search";
import { getCachedWebContent, type WebContentSnapshot } from "./web-content-cache";
import { numberParam, stringParam, toolErrorMessage as errorMessage } from "./tool-params";

export const webSearchToolName = "web_search";
export const webFetchToolName = "web_fetch";
export const webReadToolName = "web_read";

export interface WebSearchToolDetails {
  readonly action: "web_search";
  readonly query: string;
  readonly results: readonly WebSearchResult[];
  readonly error?: string;
}

/**
 * Shared by `web_fetch` and `web_read`: both hand back one ~12,000-char
 * section of a page's cached content, in the same shape `read_document`
 * uses for `part`/`totalParts`/`unit`/`sourceVersion` (see
 * `document-runtime.ts`'s `ReadDocumentToolDetails`) so the two paginated
 * read tools in this app behave identically from the model's point of view.
 */
interface WebPartToolDetails {
  readonly url: string;
  readonly title?: string;
  readonly part?: number;
  readonly totalParts?: number;
  readonly unit?: "section";
  readonly sourceVersion?: string;
  readonly complete?: boolean;
  readonly charLimit?: number;
  readonly nextPart?: number;
  readonly error?: string;
}

export interface WebFetchToolDetails extends WebPartToolDetails {
  readonly action: "web_fetch";
}

export interface WebReadToolDetails extends WebPartToolDetails {
  readonly action: "web_read";
}

type WebToolDetails = WebSearchToolDetails | WebFetchToolDetails | WebReadToolDetails;

/**
 * Reads the current settings at call time rather than at registration time, so
 * toggling web access or changing the key in Settings takes effect on the next
 * tool call instead of requiring a restart.
 */
export type WebToolsSettingsProvider = () => WebToolsSettings;

function createWebSearchTool(getSettings: WebToolsSettingsProvider): ToolDefinition<any, WebToolDetails> {
  return {
    name: webSearchToolName,
    label: "Search the web",
    description:
      "Search the web for current information, technical standards, product documentation, or anything outside your training data. Returns titles, URLs, and snippets.",
    promptSnippet: "web_search: search the web for current or reference information.",
    promptGuidelines: [
      "Use web_search whenever the user asks about current facts, standards, regulations, model numbers, or anything you are not confident is in your training data.",
      "Search in the language the source material is most likely written in.",
      "Follow up with web_fetch on the most relevant result before answering from a snippet alone — snippets are often truncated or stale.",
      "Cite the URLs you actually used at the end of your answer so the user can verify the source.",
    ],
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query. Keep it specific; include standard numbers or model names verbatim.",
        },
      },
      required: ["query"],
    },
    async execute(_toolCallId, params, signal): Promise<AgentToolResult<WebToolDetails>> {
      const query = stringParam(params, "query");
      if (!query) {
        return errorResult({ action: "web_search", query: "", results: [], error: "web_search requires a query." });
      }

      try {
        const results = await runWebSearch(query, getSettings(), signal);
        if (results.length === 0) {
          return {
            content: [{ type: "text", text: `No results found for "${query}".` }],
            details: { action: "web_search", query, results: [] },
          };
        }
        const text = results
          .map((result, index) => `${index + 1}. ${result.title}\n   ${result.url}\n   ${result.snippet}`)
          .join("\n\n");
        return {
          content: [{ type: "text", text }],
          details: { action: "web_search", query, results },
        };
      } catch (error) {
        const message = errorMessage(error);
        return errorResult({ action: "web_search", query, results: [], error: message });
      }
    },
  };
}

function createWebFetchTool(getSettings: WebToolsSettingsProvider): ToolDefinition<any, WebToolDetails> {
  return {
    name: webFetchToolName,
    label: "Read a web page",
    description:
      "Fetch a web page and return its readable text content. Use after web_search, or when the user gives you a URL. " +
      "Long pages are split into sections; pass the returned url to web_read to keep reading further sections.",
    promptSnippet: "web_fetch: read the text content of a web page by URL.",
    promptGuidelines: [
      "Use web_fetch to read a page before quoting or summarizing it — do not answer from a search snippet when the detail matters.",
      "Only http:// and https:// addresses work. Binary files such as PDFs cannot be read this way.",
      "When the content is split into sections and what you need is not in the first one, call web_read with the returned url (and part=2, 3, ...) instead of answering from the truncated start.",
      "Quote the page accurately and attribute the URL in your answer.",
    ],
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Full http(s) URL of the page to read.",
        },
      },
      required: ["url"],
    },
    async execute(_toolCallId, params, signal): Promise<AgentToolResult<WebToolDetails>> {
      const url = stringParam(params, "url");
      if (!url) {
        return errorResult({ action: "web_fetch", url: "", error: "web_fetch requires a url." });
      }

      try {
        const page = await runWebFetch(url, getSettings(), signal);
        // `runWebFetch` always caches its result on success (see
        // `cacheWebFetch` in web-search.ts), so this lookup is expected to
        // hit; the fallback below only guards against that invariant ever
        // breaking, rather than re-deriving a snapshot by hand here.
        const snapshot = getCachedWebContent(page.url);
        if (!snapshot) {
          return errorResult({ action: "web_fetch", url: page.url, error: "Fetched content could not be read back from cache." });
        }
        return renderWebPart("web_fetch", page.url, snapshot, undefined);
      } catch (error) {
        return errorResult({ action: "web_fetch", url, error: errorMessage(error) });
      }
    },
  };
}

function createWebReadTool(getSettings: WebToolsSettingsProvider): ToolDefinition<any, WebToolDetails> {
  return {
    name: webReadToolName,
    label: "Read more of a fetched page",
    description:
      "Read a section of a page already retrieved with web_fetch, without fetching it again. Use to continue past the " +
      "first section of a long page, or to re-read an earlier section.",
    promptSnippet: "web_read: read a later section of a page already fetched with web_fetch.",
    promptGuidelines: [
      "web_read never makes a network request — it only serves content web_fetch already retrieved. Call web_fetch on the URL first if you have not already.",
      "If the answer is not in the section you have, call web_read again with the next part instead of guessing from a section that does not contain it.",
      "Cite the section number a fact came from, so the user can check it against the original page.",
    ],
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The URL returned by web_fetch (it may differ from the URL you asked for, after a redirect).",
        },
        part: {
          type: "number",
          description: "1-based section number. Omit to read from the beginning.",
        },
        source_version: {
          type: "string",
          description: "Source version returned by web_fetch or a previous web_read. Rejects a stale section reference if the page has changed since.",
        },
      },
      required: ["url"],
    },
    async execute(_toolCallId, params, _signal): Promise<AgentToolResult<WebToolDetails>> {
      const url = stringParam(params, "url");
      if (!url) {
        return errorResult({ action: "web_read", url: "", error: "web_read requires a url." });
      }

      // Re-checked on every call, not just once at fetch time: a cache hit
      // must never let the model read content that current access controls
      // would refuse. Turning web access off, or narrowing the domain
      // allowlist, must take effect on already-cached content too — the
      // cache is not a side door around either setting.
      const settings = getSettings();
      if (!settings.enabled) {
        return errorResult({ action: "web_read", url, error: "Web access is turned off. Enable it under Settings → Web access." });
      }
      if (!isHostAllowed(url, settings.allowedDomains)) {
        return errorResult({ action: "web_read", url, error: "That address is outside the allowed domain list configured for this installation." });
      }

      const snapshot = getCachedWebContent(url);
      if (!snapshot) {
        return errorResult({
          action: "web_read",
          url,
          error: "This page has not been fetched in this session yet. Call web_fetch on this URL first, then use web_read to keep reading it.",
        });
      }

      const expectedVersion = stringParam(params, "source_version");
      if (expectedVersion && expectedVersion !== snapshot.sourceVersion) {
        return errorResult({
          action: "web_read",
          url,
          sourceVersion: snapshot.sourceVersion,
          error: "This page's content has changed since that section reference was created. Call web_fetch again to get the current version before continuing.",
        });
      }

      return renderWebPart("web_read", url, snapshot, numberParam(params, "part"));
    },
  };
}

/**
 * Renders one section of a cached page, in the same shape `read_document`'s
 * `renderPart` uses (see `document-runtime.ts`): a `# title — section N of M`
 * header, an out-of-range error when `requested` does not fit, a "partial
 * content" footer when extraction did not capture the whole page, a
 * "more follows" footer when further sections remain, and a trailing
 * `Source version:` line. Shared by `web_fetch` (always section 1, freshly
 * fetched) and `web_read` (any section, cache-only).
 */
function renderWebPart(
  action: "web_fetch" | "web_read",
  url: string,
  snapshot: WebContentSnapshot,
  requested: number | undefined,
): AgentToolResult<WebToolDetails> {
  const totalParts = snapshot.parts.length;
  const unit = "section" as const;
  if (totalParts === 0) {
    return errorResult({ action, url, title: snapshot.title || undefined, error: "This page has no extractable text." });
  }
  if (requested !== undefined && (!Number.isInteger(requested) || requested < 1 || requested > totalParts)) {
    return errorResult({
      action,
      url,
      title: snapshot.title || undefined,
      totalParts,
      unit,
      sourceVersion: snapshot.sourceVersion,
      error: `This page has ${totalParts} ${unit}(s); ${requested} is out of range.`,
    });
  }

  const part = requested ?? 1;
  const body = snapshot.parts[part - 1] ?? "";
  const name = snapshot.title || url;
  const header = totalParts > 1 ? `# ${name} — section ${part} of ${totalParts}\n${url}\n\n` : `# ${name}\n${url}\n\n`;
  const footer =
    (snapshot.complete === false
      ? `\n\n[Partial page: extraction reached the ${snapshot.charLimit} character limit. Unread content may still follow. Do not claim the page does not contain something beyond this point.]`
      : "") + (totalParts > part ? `\n\n[More follows — call web_read with part=${part + 1} to continue.]` : "");

  return {
    content: [{ type: "text", text: `${header}${body}${footer}\n\nSource version: ${snapshot.sourceVersion}` }],
    details: {
      action,
      url,
      title: snapshot.title || undefined,
      part,
      totalParts,
      unit,
      sourceVersion: snapshot.sourceVersion,
      complete: snapshot.complete,
      charLimit: snapshot.charLimit,
      ...(totalParts > part ? { nextPart: part + 1 } : {}),
    },
  };
}

/**
 * All three tools are always registered; whether they can actually reach the
 * network is decided per call from the live settings. Registering
 * conditionally would mean the model's tool list changed underneath a
 * running session whenever the user flipped the setting, and a disabled tool
 * that explains how to turn it on is more useful to the user than a tool that
 * silently does not exist.
 */
export function createWebRuntimeTools(
  getSettings: WebToolsSettingsProvider,
): readonly ToolDefinition<any, WebToolDetails>[] {
  return [createWebSearchTool(getSettings), createWebFetchTool(getSettings), createWebReadTool(getSettings)];
}

export function createWebRuntimeExtension(getSettings: WebToolsSettingsProvider): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    for (const tool of createWebRuntimeTools(getSettings)) {
      pi.registerTool(tool);
    }
  };
}

export function webToolsStatusSummary(settings: WebToolsSettings): string {
  return describeWebToolsMisconfiguration(settings) ?? `Web access ready (${settings.provider}).`;
}

function errorResult(details: WebToolDetails): AgentToolResult<WebToolDetails> {
  // Returned as a normal result rather than thrown, matching the orchestration
  // tools: the message ("no API key configured", "outside the allowed domains")
  // is something the model should relay to the user, not a runtime fault.
  const message = details.error ?? "Web request failed.";
  return {
    content: [{ type: "text", text: message }],
    details,
  };
}
