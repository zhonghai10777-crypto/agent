import { PRODUCT } from "../src/product";

/**
 * Search backends. The three shapes cover the realistic deployments:
 *  - `bocha`   博查 — a mainland-reachable commercial search API.
 *  - `tavily`  an LLM-oriented search API used widely outside the mainland.
 *  - `searxng` a self-hosted meta-search instance, which is the only option
 *              that works on an isolated plant network pointed at an internal
 *              index. Needs no key.
 */
export type WebSearchProvider = "bocha" | "tavily" | "searxng";

export interface WebToolsSettings {
  /** Master switch. When false neither tool is registered at all. */
  readonly enabled: boolean;
  readonly provider: WebSearchProvider;
  /** Required for bocha/tavily; ignored by searxng. */
  readonly apiKey: string;
  /** Base URL of the self-hosted instance; only used by searxng. */
  readonly searxngBaseUrl: string;
  /** Max results asked of the search backend. */
  readonly maxResults: number;
  /**
   * When non-empty, both tools refuse any host not matching one of these
   * suffixes. Intended for isolated networks that must not reach the internet.
   */
  readonly allowedDomains: readonly string[];
}

export const DEFAULT_WEB_TOOLS_SETTINGS: WebToolsSettings = {
  // Off by default: an app that silently starts making outbound requests is not
  // something a plant-network deployment can accept without review.
  enabled: false,
  provider: "bocha",
  apiKey: "",
  searxngBaseUrl: "",
  maxResults: 5,
  allowedDomains: [],
};

/** Hard cap on fetched bytes, so one huge page cannot blow up the context. */
const MAX_FETCH_BYTES = 5 * 1024 * 1024;
/** Hard cap on extracted characters handed back to the model. */
const MAX_EXTRACT_CHARS = 40_000;
const REQUEST_TIMEOUT_MS = 20_000;
const USER_AGENT = `${PRODUCT.name}/1.0 (+desktop assistant)`;

export interface WebSearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

export function normalizeWebToolsSettings(input: unknown): WebToolsSettings {
  if (typeof input !== "object" || input === null) {
    return DEFAULT_WEB_TOOLS_SETTINGS;
  }
  const raw = input as Partial<Record<keyof WebToolsSettings, unknown>>;
  const provider: WebSearchProvider =
    raw.provider === "tavily" || raw.provider === "searxng" || raw.provider === "bocha"
      ? raw.provider
      : DEFAULT_WEB_TOOLS_SETTINGS.provider;
  const maxResultsRaw = typeof raw.maxResults === "number" ? Math.trunc(raw.maxResults) : NaN;
  return {
    enabled: raw.enabled === true,
    provider,
    apiKey: typeof raw.apiKey === "string" ? raw.apiKey.trim() : "",
    searxngBaseUrl: typeof raw.searxngBaseUrl === "string" ? raw.searxngBaseUrl.trim() : "",
    maxResults: Number.isFinite(maxResultsRaw) ? Math.min(Math.max(maxResultsRaw, 1), 20) : DEFAULT_WEB_TOOLS_SETTINGS.maxResults,
    allowedDomains: Array.isArray(raw.allowedDomains)
      ? raw.allowedDomains
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => entry.trim().toLowerCase().replace(/^\.+/, ""))
          .filter(Boolean)
      : [],
  };
}

/**
 * Explains why the current settings cannot be used, or undefined when they can.
 * Returned to the model as the tool error so it can tell the user what to fix
 * instead of retrying a request that structurally cannot work.
 */
export function describeWebToolsMisconfiguration(settings: WebToolsSettings): string | undefined {
  if (!settings.enabled) {
    return "Web access is turned off. Enable it under Settings → Web access.";
  }
  if (settings.provider === "searxng") {
    if (!settings.searxngBaseUrl) {
      return "No SearXNG address is configured. Set one under Settings → Web access.";
    }
    if (!isHttpUrl(settings.searxngBaseUrl)) {
      return "The configured SearXNG address is not a valid http(s) URL.";
    }
    return undefined;
  }
  if (!settings.apiKey) {
    return `No API key is configured for ${settings.provider}. Add one under Settings → Web access.`;
  }
  return undefined;
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Enforces the allowlist. An empty list means "no restriction"; a non-empty one
 * matches the host exactly or as a subdomain, never as a bare substring — so
 * `example.com` does not authorize `evil-example.com.attacker.net`.
 */
export function isHostAllowed(urlValue: string, allowedDomains: readonly string[]): boolean {
  if (allowedDomains.length === 0) {
    return true;
  }
  let host: string;
  try {
    host = new URL(urlValue).hostname.toLowerCase();
  } catch {
    return false;
  }
  return allowedDomains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

async function requestJson(
  url: string,
  init: { readonly method: string; readonly headers: Record<string, string>; readonly body?: string },
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const response = await fetchWithTimeout(url, init, signal);
  if (!response.ok) {
    throw new Error(`Search request failed with HTTP ${response.status}.`);
  }
  return response.json();
}

async function fetchWithTimeout(
  url: string,
  init: { readonly method: string; readonly headers: Record<string, string>; readonly body?: string },
  signal: AbortSignal | undefined,
): Promise<Response> {
  const controller = new AbortController();
  const abortForCaller = () => controller.abort();
  signal?.addEventListener("abort", abortForCaller);
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: init.method,
      headers: init.headers,
      ...(init.body === undefined ? {} : { body: init.body }),
      signal: controller.signal,
      redirect: "follow",
    });
  } catch (error) {
    if (controller.signal.aborted && !signal?.aborted) {
      throw new Error(`The request timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortForCaller);
  }
}

export async function runWebSearch(
  query: string,
  settings: WebToolsSettings,
  signal?: AbortSignal,
): Promise<readonly WebSearchResult[]> {
  const misconfiguration = describeWebToolsMisconfiguration(settings);
  if (misconfiguration) {
    throw new Error(misconfiguration);
  }

  const results =
    settings.provider === "tavily"
      ? await searchTavily(query, settings, signal)
      : settings.provider === "searxng"
        ? await searchSearxng(query, settings, signal)
        : await searchBocha(query, settings, signal);

  // Apply the allowlist to results too: on a locked-down deployment the model
  // must not even see links it is not allowed to open.
  return results.filter((result) => isHostAllowed(result.url, settings.allowedDomains)).slice(0, settings.maxResults);
}

async function searchBocha(
  query: string,
  settings: WebToolsSettings,
  signal: AbortSignal | undefined,
): Promise<readonly WebSearchResult[]> {
  const payload = await requestJson(
    "https://api.bochaai.com/v1/web-search",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, count: settings.maxResults, summary: true }),
    },
    signal,
  );
  const pages = pick(pick(pick(payload, "data"), "webPages"), "value");
  if (!Array.isArray(pages)) {
    return [];
  }
  return pages.flatMap((entry) => {
    const url = stringField(entry, "url");
    if (!url) {
      return [];
    }
    return [{
      title: stringField(entry, "name") ?? url,
      url,
      snippet: stringField(entry, "summary") ?? stringField(entry, "snippet") ?? "",
    }];
  });
}

async function searchTavily(
  query: string,
  settings: WebToolsSettings,
  signal: AbortSignal | undefined,
): Promise<readonly WebSearchResult[]> {
  const payload = await requestJson(
    "https://api.tavily.com/search",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, max_results: settings.maxResults }),
    },
    signal,
  );
  const results = pick(payload, "results");
  if (!Array.isArray(results)) {
    return [];
  }
  return results.flatMap((entry) => {
    const url = stringField(entry, "url");
    if (!url) {
      return [];
    }
    return [{
      title: stringField(entry, "title") ?? url,
      url,
      snippet: stringField(entry, "content") ?? "",
    }];
  });
}

async function searchSearxng(
  query: string,
  settings: WebToolsSettings,
  signal: AbortSignal | undefined,
): Promise<readonly WebSearchResult[]> {
  const base = settings.searxngBaseUrl.replace(/\/+$/, "");
  const url = `${base}/search?q=${encodeURIComponent(query)}&format=json&safesearch=1`;
  const payload = await requestJson(url, { method: "GET", headers: { Accept: "application/json" } }, signal);
  const results = pick(payload, "results");
  if (!Array.isArray(results)) {
    return [];
  }
  return results.flatMap((entry) => {
    const link = stringField(entry, "url");
    if (!link) {
      return [];
    }
    return [{
      title: stringField(entry, "title") ?? link,
      url: link,
      snippet: stringField(entry, "content") ?? "",
    }];
  });
}

export interface WebFetchResult {
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly truncated: boolean;
}

export async function runWebFetch(
  rawUrl: string,
  settings: WebToolsSettings,
  signal?: AbortSignal,
): Promise<WebFetchResult> {
  if (!settings.enabled) {
    throw new Error("Web access is turned off. Enable it under Settings → Web access.");
  }
  if (!isHttpUrl(rawUrl)) {
    throw new Error("Only http:// and https:// addresses can be fetched.");
  }
  if (!isHostAllowed(rawUrl, settings.allowedDomains)) {
    throw new Error("That address is outside the allowed domain list configured for this installation.");
  }

  const response = await fetchWithTimeout(
    rawUrl,
    { method: "GET", headers: { "User-Agent": USER_AGENT, Accept: "text/html,text/plain,*/*" } },
    signal,
  );
  if (!response.ok) {
    throw new Error(`The page could not be loaded (HTTP ${response.status}).`);
  }
  // Redirects are followed, so re-check the final host: an allowed URL must not
  // become a bypass by redirecting off the allowlist.
  if (!isHostAllowed(response.url || rawUrl, settings.allowedDomains)) {
    throw new Error("The address redirected outside the allowed domain list.");
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (/^(image|audio|video|application\/(pdf|zip|octet-stream))/i.test(contentType)) {
    // Decoding a binary body as text is how you get a confidently wrong answer
    // over mojibake. Refuse clearly instead.
    throw new Error(`This address returns ${contentType.split(";")[0] || "binary"} content, which cannot be read as text.`);
  }

  const body = await readCappedText(response);
  const isHtml = /html/i.test(contentType) || /^\s*<(!doctype|html)/i.test(body.text);
  const extracted = isHtml ? extractReadableText(body.text) : { title: "", text: body.text.trim() };
  const truncated = body.truncated || extracted.text.length > MAX_EXTRACT_CHARS;

  return {
    url: response.url || rawUrl,
    title: extracted.title,
    text: extracted.text.slice(0, MAX_EXTRACT_CHARS),
    truncated,
  };
}

async function readCappedText(response: Response): Promise<{ readonly text: string; readonly truncated: boolean }> {
  const buffer = await response.arrayBuffer();
  const truncated = buffer.byteLength > MAX_FETCH_BYTES;
  const slice = truncated ? buffer.slice(0, MAX_FETCH_BYTES) : buffer;
  const charset = /charset=([\w-]+)/i.exec(response.headers.get("content-type") ?? "")?.[1];
  return { text: decodeBody(slice, charset), truncated };
}

/**
 * Decodes with the declared charset when possible. This matters well beyond
 * edge cases here: a lot of Chinese technical material is still served as GB
 * 18030/GBK, and decoding it as UTF-8 produces mojibake that reads to the model
 * as plausible-but-wrong text rather than as an obvious failure.
 */
function decodeBody(buffer: ArrayBuffer, charset: string | undefined): string {
  const candidates = [charset, "utf-8"].filter((entry): entry is string => Boolean(entry));
  for (const candidate of candidates) {
    try {
      return new TextDecoder(candidate).decode(buffer);
    } catch {
      // Unknown label — fall through to the next candidate.
    }
  }
  return new TextDecoder("utf-8").decode(buffer);
}

const BLOCK_LEVEL_TAGS =
  "address|article|aside|blockquote|br|dd|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul";

/**
 * Minimal readability pass: drop the non-content elements, keep block structure
 * as line breaks, unescape entities, and collapse the whitespace storm that
 * results. Deliberately dependency-free — an intranet deployment should not
 * grow a parser dependency (and its update cadence) just to read a page.
 */
export function extractReadableText(html: string): { readonly title: string; readonly text: string } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? decodeEntities(stripTags(titleMatch[1] ?? "")).trim() : "";

  let working = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|canvas|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(nav|header|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");

  working = working.replace(new RegExp(`</?(?:${BLOCK_LEVEL_TAGS})\\b[^>]*>`, "gi"), "\n");
  working = stripTags(working);
  working = decodeEntities(working);

  const text = working
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n")
    // Three or more newlines add nothing but tokens.
    .replace(/\n{3,}/g, "\n\n");

  return { title, text };
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, " ");
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  middot: "·",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
};

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => safeFromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec: string) => safeFromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-z][a-z0-9]*);/gi, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match);
}

function safeFromCodePoint(codePoint: number): string {
  if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    return "";
  }
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return "";
  }
}

function pick(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

function stringField(value: unknown, key: string): string | undefined {
  const field = pick(value, key);
  return typeof field === "string" && field.trim() ? field.trim() : undefined;
}
