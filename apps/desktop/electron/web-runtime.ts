import type { ExtensionAPI, ExtensionFactory, ToolDefinition, AgentToolResult } from "@earendil-works/pi-coding-agent";
import {
  describeWebToolsMisconfiguration,
  runWebFetch,
  runWebSearch,
  type WebSearchResult,
  type WebToolsSettings,
} from "./web-search";

export const webSearchToolName = "web_search";
export const webFetchToolName = "web_fetch";

export interface WebSearchToolDetails {
  readonly action: "web_search";
  readonly query: string;
  readonly results: readonly WebSearchResult[];
  readonly error?: string;
}

export interface WebFetchToolDetails {
  readonly action: "web_fetch";
  readonly url: string;
  readonly title?: string;
  readonly truncated?: boolean;
  readonly error?: string;
}

type WebToolDetails = WebSearchToolDetails | WebFetchToolDetails;

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
      "Fetch a web page and return its readable text content. Use after web_search, or when the user gives you a URL.",
    promptSnippet: "web_fetch: read the text content of a web page by URL.",
    promptGuidelines: [
      "Use web_fetch to read a page before quoting or summarizing it — do not answer from a search snippet when the detail matters.",
      "Only http:// and https:// addresses work. Binary files such as PDFs cannot be read this way.",
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
        const header = page.title ? `# ${page.title}\n${page.url}\n\n` : `${page.url}\n\n`;
        const footer = page.truncated ? "\n\n[Content truncated — the page was longer than the read limit.]" : "";
        return {
          content: [{ type: "text", text: `${header}${page.text}${footer}` }],
          details: {
            action: "web_fetch",
            url: page.url,
            ...(page.title ? { title: page.title } : {}),
            ...(page.truncated ? { truncated: true } : {}),
          },
        };
      } catch (error) {
        return errorResult({ action: "web_fetch", url, error: errorMessage(error) });
      }
    },
  };
}

/**
 * Both tools are always registered; whether they can actually reach the network
 * is decided per call from the live settings. Registering conditionally would
 * mean the model's tool list changed underneath a running session whenever the
 * user flipped the setting, and a disabled tool that explains how to turn it on
 * is more useful to the user than a tool that silently does not exist.
 */
export function createWebRuntimeTools(
  getSettings: WebToolsSettingsProvider,
): readonly ToolDefinition<any, WebToolDetails>[] {
  return [createWebSearchTool(getSettings), createWebFetchTool(getSettings)];
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
