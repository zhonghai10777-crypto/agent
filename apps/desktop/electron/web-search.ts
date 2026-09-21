import { PRODUCT } from "../src/product";
import {
  canBorrowModelProviderKey,
  isWebSearchProvider,
  type WebSearchProvider,
} from "../src/web-search-providers";
import { cacheWebFetch, type WebContentSnapshot } from "./web-content-cache";

/**
 * Search backends. The four shapes cover the realistic deployments:
 *  - `deepseek` DeepSeek's own server-side search, billed to the DeepSeek model
 *               key the user has already configured — so web access costs no
 *               extra signup. Returns sources without snippets (see
 *               `searchDeepSeek`).
 *  - `bocha`   博查 — a mainland-reachable commercial search API.
 *  - `tavily`  an LLM-oriented search API used widely outside the mainland.
 *  - `searxng` a self-hosted meta-search instance, which is the only option
 *              that works on an isolated plant network pointed at an internal
 *              index. Needs no key.
 *
 * The provider identity itself lives in `src/web-search-providers` so the
 * renderer shares it rather than mirroring it.
 */

/** pi's built-in provider id whose credential the deepseek backend borrows. */
export const DEEPSEEK_PROVIDER_ID = "deepseek";

/** Official DeepSeek API host. Server-side search is only offered there. */
const DEEPSEEK_API_HOST = "api.deepseek.com";

/**
 * Whether a custom endpoint points at DeepSeek's own API.
 *
 * A user who reaches DeepSeek through a custom endpoint (any id: `deepseek-api`,
 * `ds`, …) has already entered the one credential search needs, so search
 * borrows it instead of demanding the same key a second time under the built-in
 * `deepseek` id — which is otherwise unreachable from the UI once a custom
 * endpoint occupies the same account.
 */
export function isDeepSeekEndpoint(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === DEEPSEEK_API_HOST || host.endsWith(`.${DEEPSEEK_API_HOST}`);
  } catch {
    return false;
  }
}

export interface WebToolsSettings {
  /** Master switch; the tools stay registered and report "off" (see `createWebRuntimeTools`). */
  readonly enabled: boolean;
  readonly provider: WebSearchProvider;
  /**
   * Required for bocha/tavily; ignored by searxng. Optional for deepseek, which
   * falls back to the configured DeepSeek model credential when this is empty.
   */
  readonly apiKey: string;
  /** Base URL of the self-hosted instance; only used by searxng. */
  readonly searxngBaseUrl: string;
  /**
   * Max results asked of the search backend, and — for every provider except
   * deepseek — the count actually requested from it.
   *
   * For deepseek specifically this is a purely LOCAL post-hoc slice, not a
   * server-side parameter: DeepSeek's server-side search tool has no
   * "how many results" knob. What it does have is `deepseekMaxUses` below,
   * which bounds how many *search calls* the model may issue in one turn —
   * a different axis entirely (calls vs. results-per-call). Conflating the
   * two would either starve the model of search attempts or truncate
   * perfectly good sources for no server-side reason, so keep them separate
   * in code as well as in documentation.
   */
  readonly maxResults: number;
  /**
   * When non-empty, both tools refuse any host not matching one of these
   * suffixes. Intended for isolated networks that must not reach the internet.
   *
   * For deepseek this is also sent to the server as `allowed_domains` (see
   * `searchDeepSeek`), so a restricted search burns its search budget only on
   * hosts that would pass the check anyway — filtering post-hoc locally, as
   * every other provider still does, would waste server-side search calls on
   * results that get thrown away. The local `isHostAllowed` filter stays in
   * place regardless, as the actual enforcement boundary: a compromised or
   * misbehaving server sending `allowed_domains` is not a promise it honors it.
   */
  readonly allowedDomains: readonly string[];
  /** DeepSeek model id used for the throwaway search request. See `DEEPSEEK_DEFAULT_MODEL`. */
  readonly deepseekModel: string;
  /** `max_tokens` for the DeepSeek search request. See `DEEPSEEK_DEFAULT_MAX_TOKENS`. */
  readonly deepseekMaxTokens: number;
  /** `max_uses` — the number of search calls DeepSeek may make in one turn. See `DEEPSEEK_DEFAULT_MAX_USES`. */
  readonly deepseekMaxUses: number;
}

/**
 * Current DeepSeek model id for the search tool; the prose it writes is
 * discarded, so this only needs to be cheap and tool-capable.
 * `deepseek-v4-flash` was the id before DeepSeek's rename — it is a retired
 * alias the API still accepts (served by V4.1-Flash under the hood) but new
 * code should use the current id below.
 */
const DEEPSEEK_DEFAULT_MODEL = "deepseek-flash";
/**
 * Output budget for the throwaway answer. Generous enough that the model can
 * think before it searches — running out mid-thought would yield zero results —
 * and still fractions of a cent.
 */
const DEEPSEEK_DEFAULT_MAX_TOKENS = 4096;
/**
 * More than one search is allowed because a malformed first call (the model
 * occasionally emits an empty query) otherwise burns the only attempt and the
 * whole request comes back as `max_uses_exceeded`.
 */
const DEEPSEEK_DEFAULT_MAX_USES = 5;

const DEEPSEEK_MIN_MAX_TOKENS = 256;
const DEEPSEEK_MAX_MAX_TOKENS = 16_384;
const DEEPSEEK_MIN_MAX_USES = 1;
const DEEPSEEK_MAX_MAX_USES = 10;

export const DEFAULT_WEB_TOOLS_SETTINGS: WebToolsSettings = {
  // Off by default: an app that silently starts making outbound requests is not
  // something a plant-network deployment can accept without review.
  enabled: false,
  // DeepSeek by default because it needs no second signup: it reuses the model
  // key the user already has. Existing installs keep whatever they saved —
  // normalization only falls back to this when nothing valid is stored.
  provider: "deepseek",
  apiKey: "",
  searxngBaseUrl: "",
  // Measured against a real DeepSeek key: one search call returns 10 sources,
  // and DeepSeek bills by search CALL, not by result count — so slicing to 5
  // locally was throwing away half of what had already been paid for. Every
  // other provider is asked for `maxResults` server-side (see `searchWith`),
  // so raising this does not cost them anything extra either.
  maxResults: 10,
  allowedDomains: [],
  deepseekModel: DEEPSEEK_DEFAULT_MODEL,
  deepseekMaxTokens: DEEPSEEK_DEFAULT_MAX_TOKENS,
  deepseekMaxUses: DEEPSEEK_DEFAULT_MAX_USES,
};

/** Hard cap on fetched bytes, so one huge page cannot blow up the context. */
const MAX_FETCH_BYTES = 5 * 1024 * 1024;
/**
 * Hard cap on extracted characters kept in the content cache for one page
 * (see `web-content-cache.ts`). Raised from the old 40,000 hard read limit —
 * which had no continuation mechanism at all — because technical
 * specifications, standards text and parameter manuals routinely run past
 * that, often with the limiting clause past the halfway point. What is
 * handed to the model in any ONE `web_fetch`/`web_read` call is still only
 * about 12,000 chars (`PART_CHAR_BUDGET` in web-content-cache.ts); this is
 * the ceiling on how much of a page can be paged through at all.
 */
const MAX_EXTRACT_CHARS = 400_000;
const REQUEST_TIMEOUT_MS = 20_000;
const USER_AGENT = `${PRODUCT.name}/1.0 (+desktop assistant)`;

export interface WebSearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  /**
   * DeepSeek's raw `page_age` string (e.g. "2025-03-11" or "3 days ago"), kept
   * verbatim. Deliberately not parsed into a normalized date — the field's
   * format is not documented, so a failed parse would just hide an unknown
   * age behind a wrong one. Absent for other providers or when DeepSeek omits
   * it on a given result.
   */
  readonly pageAge?: string;
}

/**
 * Truncates to an integer and clamps into `[min, max]`; falls back to
 * `fallback` for anything that isn't a finite number (NaN, +/-Infinity, or a
 * non-number) rather than letting it through as an unbounded value — this is
 * the one path a malformed or hand-edited settings file reaches this code
 * through, so "reject silently to a safe default" beats "propagate garbage
 * into a request body".
 */
function normalizeIntInRange(raw: unknown, min: number, max: number, fallback: number): number {
  const truncated = typeof raw === "number" ? Math.trunc(raw) : NaN;
  return Number.isFinite(truncated) ? Math.min(Math.max(truncated, min), max) : fallback;
}

export function normalizeWebToolsSettings(input: unknown): WebToolsSettings {
  if (typeof input !== "object" || input === null) {
    return DEFAULT_WEB_TOOLS_SETTINGS;
  }
  const raw = input as Partial<Record<keyof WebToolsSettings, unknown>>;
  const provider: WebSearchProvider = isWebSearchProvider(raw.provider)
    ? raw.provider
    : DEFAULT_WEB_TOOLS_SETTINGS.provider;
  return {
    enabled: raw.enabled === true,
    provider,
    apiKey: typeof raw.apiKey === "string" ? raw.apiKey.trim() : "",
    searxngBaseUrl: typeof raw.searxngBaseUrl === "string" ? raw.searxngBaseUrl.trim() : "",
    maxResults: normalizeIntInRange(raw.maxResults, 1, 20, DEFAULT_WEB_TOOLS_SETTINGS.maxResults),
    allowedDomains: Array.isArray(raw.allowedDomains)
      ? raw.allowedDomains
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => entry.trim().toLowerCase().replace(/^\.+/, ""))
          .filter(Boolean)
      : [],
    // Absent on any settings file saved before these fields existed — falls
    // back to the current defaults rather than failing to read the file, so
    // an old web-tools.json keeps working with no migration step.
    deepseekModel:
      typeof raw.deepseekModel === "string" && raw.deepseekModel.trim()
        ? raw.deepseekModel.trim()
        : DEFAULT_WEB_TOOLS_SETTINGS.deepseekModel,
    deepseekMaxTokens: normalizeIntInRange(
      raw.deepseekMaxTokens,
      DEEPSEEK_MIN_MAX_TOKENS,
      DEEPSEEK_MAX_MAX_TOKENS,
      DEFAULT_WEB_TOOLS_SETTINGS.deepseekMaxTokens,
    ),
    deepseekMaxUses: normalizeIntInRange(
      raw.deepseekMaxUses,
      DEEPSEEK_MIN_MAX_USES,
      DEEPSEEK_MAX_MAX_USES,
      DEFAULT_WEB_TOOLS_SETTINGS.deepseekMaxUses,
    ),
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
    // Point at a field that actually exists. Settings → Web access holds the key
    // input for every backend, including deepseek; the provider fallback is
    // mentioned second because it only helps someone who already configured
    // DeepSeek as a model provider.
    return canBorrowModelProviderKey(settings.provider)
      ? "No DeepSeek API key is configured. Add one under Settings → Web access, or configure DeepSeek under Settings → Providers and web search will reuse that key."
      : `No API key is configured for ${settings.provider}. Add one under Settings → Web access.`;
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

interface FetchInit {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
  readonly redirect?: "follow" | "manual";
}

/**
 * Owns the whole lifecycle of one outbound request: the AbortController that
 * backs the timeout, AND the timer/listener cleanup, live for as long as
 * `consume` is running — not just until the response headers arrive.
 *
 * This matters because the previous shape cleared the timer in a `finally`
 * attached to the `fetch()` call itself, so `REQUEST_TIMEOUT_MS` only ever
 * bounded the time to get a `Response` object; a server that returned headers
 * immediately and then stalled the body forever was never caught by it. Folding
 * the body read into `consume` means the same timer — and the same
 * AbortSignal — governs header AND body, so a stalled body still aborts.
 */
async function fetchWithBudget<T>(
  url: string,
  init: FetchInit,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  consume: (response: Response) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abortForCaller = () => controller.abort();
  signal?.addEventListener("abort", abortForCaller);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(url, {
      method: init.method,
      headers: init.headers,
      ...(init.body === undefined ? {} : { body: init.body }),
      signal: controller.signal,
      redirect: init.redirect ?? "follow",
    });
    return await consume(response);
  } catch (error) {
    if (timedOut) {
      throw new Error(`The request timed out after ${timeoutMs / 1000}s.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortForCaller);
  }
}

/**
 * Streams a response body up to `maxBytes`, cancelling the underlying reader
 * (and therefore the connection) the instant the cap is crossed instead of
 * buffering the whole thing first. A chunked, Content-Length-less response
 * (the common case for a generated or proxied page) previously had no limit
 * at all until the full body had already been downloaded into memory.
 */
async function readCappedBytes(
  response: Response,
  maxBytes: number,
): Promise<{ readonly bytes: Uint8Array; readonly truncated: boolean }> {
  const body = response.body;
  if (!body) {
    return { bytes: new Uint8Array(0), truncated: false };
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!value || value.byteLength === 0) {
      continue;
    }
    const remaining = maxBytes - total;
    const take = Math.min(value.byteLength, remaining);
    if (take > 0) {
      chunks.push(take === value.byteLength ? value : value.subarray(0, take));
      total += take;
    }
    if (value.byteLength > remaining) {
      truncated = true;
      await reader.cancel("byte cap exceeded");
      break;
    }
  }
  return { bytes: chunks.length > 0 ? Buffer.concat(chunks, total) : new Uint8Array(0), truncated };
}

async function requestJson(
  url: string,
  init: { readonly method: string; readonly headers: Record<string, string>; readonly body?: string },
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<unknown> {
  return fetchWithBudget(url, init, signal, timeoutMs, async (response) => {
    if (!response.ok) {
      throw new Error(`Search request failed with HTTP ${response.status}.`);
    }
    // The JSON reply needs the same hard cap as a fetched page: an unbounded or
    // malfunctioning search backend must not be read forever either.
    const { bytes, truncated } = await readCappedBytes(response, MAX_FETCH_BYTES);
    if (truncated) {
      throw new Error("The search response was larger than the read limit.");
    }
    return JSON.parse(decodeBody(bytes, undefined)) as unknown;
  });
}

export async function runWebSearch(
  query: string,
  settings: WebToolsSettings,
  signal?: AbortSignal,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<readonly WebSearchResult[]> {
  const misconfiguration = describeWebToolsMisconfiguration(settings);
  if (misconfiguration) {
    throw new Error(misconfiguration);
  }

  const results = await searchWith(settings.provider, query, settings, signal, timeoutMs);

  // Apply the allowlist to results too: on a locked-down deployment the model
  // must not even see links it is not allowed to open.
  return results.filter((result) => isHostAllowed(result.url, settings.allowedDomains)).slice(0, settings.maxResults);
}

function searchWith(
  provider: WebSearchProvider,
  query: string,
  settings: WebToolsSettings,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<readonly WebSearchResult[]> {
  switch (provider) {
    case "deepseek":
      return searchDeepSeek(query, settings, signal, timeoutMs);
    case "tavily":
      return searchTavily(query, settings, signal, timeoutMs);
    case "searxng":
      return searchSearxng(query, settings, signal, timeoutMs);
    case "bocha":
      return searchBocha(query, settings, signal, timeoutMs);
  }
}

/**
 * DeepSeek's Anthropic-compatible endpoint. Server-side search is only offered
 * there and on the Responses API — the OpenAI-compatible `/chat/completions`
 * rejects the tool outright (`unknown variant web_search`), so this backend
 * talks to `/anthropic` regardless of which API shape the chat session uses.
 *
 * Pinned to the official host on purpose: the tool is a DeepSeek server feature,
 * and a relay that only proxies `/v1` chat completions cannot serve it.
 */
const DEEPSEEK_SEARCH_ENDPOINT = "https://api.deepseek.com/anthropic/v1/messages";

/**
 * Runs the search on DeepSeek's servers and harvests the sources out of the
 * `web_search_tool_result` blocks.
 *
 * Note the shape difference from the other backends: DeepSeek returns each
 * source's title and URL but keeps the page text in an opaque `encrypted_content`
 * field meant for feeding back to the model, so there is no snippet to pass on.
 * The model is expected to follow up with `web_fetch`, which the tool
 * description already tells it to do.
 */
async function searchDeepSeek(
  query: string,
  settings: WebToolsSettings,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<readonly WebSearchResult[]> {
  const payload = await requestJson(
    DEEPSEEK_SEARCH_ENDPOINT,
    {
      method: "POST",
      headers: {
        "x-api-key": settings.apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: settings.deepseekModel,
        max_tokens: settings.deepseekMaxTokens,
        messages: [{ role: "user", content: `Search the web for: ${query}` }],
        // No tool_choice: forcing the tool makes the model emit a call with an
        // empty input, which the server rejects as `invalid_tool_input`.
        tools: [
          {
            type: "web_search_20250305",
            name: "web_search",
            max_uses: settings.deepseekMaxUses,
            // Pushed down to the server so a restricted deployment doesn't
            // spend a search call on a source it would only throw away
            // locally afterward — see the `allowedDomains` doc comment on
            // `WebToolsSettings` for why this is server-side, not local-only.
            ...(settings.allowedDomains.length > 0 ? { allowed_domains: settings.allowedDomains } : {}),
          },
        ],
      }),
    },
    signal,
    timeoutMs,
  );
  return parseDeepSeekSearchResults(payload).results;
}

/**
 * What `parseDeepSeekSearchResults` recovers from one Anthropic-shaped
 * DeepSeek reply, beyond the flat source list `WebSearchResult[]` already
 * gives every other backend.
 */
export interface DeepSeekSearchOutcome {
  readonly results: readonly WebSearchResult[];
  /** Top-level `stop_reason` (`end_turn`, `max_tokens`, `tool_use`, …), when present. */
  readonly stopReason?: string;
  /** `usage.server_tool_use.web_search_requests` — actual search calls billed, when present. */
  readonly webSearchRequests?: number;
}

/**
 * Pulls the sources out of an Anthropic-shaped DeepSeek response.
 *
 * Split from the request so the block walk can be tested without a live key: the
 * response nests results two levels deep and interleaves them with reasoning,
 * text and per-search error entries, which is exactly the shape that quietly
 * regresses when the API adds a block type.
 *
 * Three outcomes are kept distinct rather than collapsed into "no results":
 *  - a real empty result (a `web_search_tool_result` block exists, its
 *    `content` is a well-formed but empty list) — not an error, just nothing
 *    found;
 *  - the model never called the tool at all (no `web_search_tool_result`
 *    block anywhere in `content`) — the caller should say so, not "no
 *    results found", since the model didn't even try;
 *  - a protocol error or a shape this parser does not recognize (a bare
 *    `web_search_tool_result_error` object — DeepSeek's actual failure shape,
 *    not an array — or a `content` value that is neither) — surfaced with
 *    detail instead of silently discarded.
 *
 * A response that mixes a successful search with a failed or unrecognized one
 * still returns the successful sources: a partially failed multi-search turn
 * is more useful to the model than an error.
 */
export function parseDeepSeekSearchResults(payload: unknown): DeepSeekSearchOutcome {
  const stopReason = stringField(payload, "stop_reason");
  const webSearchRequests = numberField(pick(pick(payload, "usage"), "server_tool_use"), "web_search_requests");
  const meta = {
    ...(stopReason ? { stopReason } : {}),
    ...(webSearchRequests !== undefined ? { webSearchRequests } : {}),
  };

  const content = pick(payload, "content");
  if (!Array.isArray(content)) {
    throw new Error("DeepSeek did not perform a web search for this query.");
  }

  const searchBlocks = content.filter((block) => stringField(block, "type") === "web_search_tool_result");
  if (searchBlocks.length === 0) {
    throw new Error("DeepSeek did not perform a web search for this query.");
  }

  const results: WebSearchResult[] = [];
  const seen = new Set<string>();
  const errorCodes: string[] = [];
  let sawUnrecognizedBlock = false;

  for (const block of searchBlocks) {
    const entries = pick(block, "content");

    if (Array.isArray(entries)) {
      for (const entry of entries) {
        const entryType = stringField(entry, "type");
        if (entryType === "web_search_tool_result_error") {
          const code = stringField(entry, "error_code");
          if (code) {
            errorCodes.push(code);
          }
          continue;
        }
        const url = stringField(entry, "url");
        // The model may repeat a source across several searches in one turn.
        if (entryType !== "web_search_result" || !url || seen.has(url)) {
          continue;
        }
        seen.add(url);
        const pageAge = stringField(entry, "page_age");
        results.push({
          title: stringField(entry, "title") ?? url,
          url,
          snippet: "",
          ...(pageAge ? { pageAge } : {}),
        });
      }
      continue;
    }

    // The documented failure shape: `content` is a single error object, not
    // an array — this used to be silently skipped by an `Array.isArray`
    // guard, which is exactly how `max_uses_exceeded` and friends ended up
    // reported to the user as "no results found".
    if (isPlainObject(entries) && stringField(entries, "type") === "web_search_tool_result_error") {
      const code = stringField(entries, "error_code");
      if (code) {
        errorCodes.push(code);
      }
      continue;
    }

    // Neither a results array nor a recognized error object.
    sawUnrecognizedBlock = true;
  }

  if (results.length === 0 && errorCodes.length > 0) {
    throw new Error(`DeepSeek search failed (${[...new Set(errorCodes)].join(", ")}).`);
  }
  if (results.length === 0 && sawUnrecognizedBlock) {
    throw new Error("DeepSeek returned a web search result in a shape this app does not recognize.");
  }
  return { results, ...meta };
}

async function searchBocha(
  query: string,
  settings: WebToolsSettings,
  signal: AbortSignal | undefined,
  timeoutMs: number,
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
    timeoutMs,
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
  timeoutMs: number,
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
    timeoutMs,
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
  timeoutMs: number,
): Promise<readonly WebSearchResult[]> {
  const base = settings.searxngBaseUrl.replace(/\/+$/, "");
  const url = `${base}/search?q=${encodeURIComponent(query)}&format=json&safesearch=1`;
  const payload = await requestJson(url, { method: "GET", headers: { Accept: "application/json" } }, signal, timeoutMs);
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
  /** Full extracted text, up to `MAX_EXTRACT_CHARS` — NOT the ~12,000-char
   * slice handed to the model per call; that pagination happens in
   * `web-runtime.ts` off the cache entry this call also writes (see
   * `sourceVersion`/`totalParts` below and `web-content-cache.ts`). */
  readonly text: string;
  /** True when extraction hit `MAX_EXTRACT_CHARS`, or the fetch itself was
   * byte-capped — i.e. content beyond `text` may still exist. */
  readonly truncated: boolean;
  /**
   * The cache entry this fetch just wrote, handed over directly rather than
   * re-derived: it already carries the version, section count and
   * completeness a paginated response needs, so the caller does not have to
   * look up by URL what this call just produced.
   */
  readonly snapshot: WebContentSnapshot;
}

/** Hard cap on redirect hops `runWebFetch` will follow before giving up. */
const MAX_REDIRECTS = 5;

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

type FetchHopOutcome =
  | { readonly kind: "redirect"; readonly status: number; readonly location: string | null }
  | {
      readonly kind: "final";
      readonly url: string;
      readonly contentType: string;
      readonly body: { readonly text: string; readonly truncated: boolean };
    };

/** Why a URL may not be reached right now, or undefined when it may. */
export type WebAccessErrorCode = "WEB_DISABLED" | "WEB_INVALID_URL" | "WEB_ACCESS_RESTRICTED";

export interface WebAccessRefusal {
  readonly message: string;
  readonly code: WebAccessErrorCode;
}

/**
 * The one place that decides whether a URL may be reached under the current
 * settings, and says so in the words the user sees.
 *
 * Both entry points ask this: `runWebFetch` before going to the network, and
 * `web_read` before serving a cache hit — a cached page must not stay readable
 * after web access is switched off or the allowlist is narrowed. Keeping the
 * pair of checks (and their wording) in one function is what stops those two
 * paths from drifting into different answers for the same URL.
 */
export function describeWebAccessRefusal(url: string, settings: WebToolsSettings): WebAccessRefusal | undefined {
  if (!settings.enabled) {
    return { message: "Web access is turned off. Enable it under Settings → Web access.", code: "WEB_DISABLED" };
  }
  if (!isHttpUrl(url)) {
    return { message: "Only http:// and https:// addresses can be fetched.", code: "WEB_INVALID_URL" };
  }
  if (!isHostAllowed(url, settings.allowedDomains)) {
    return {
      message: "That address is outside the allowed domain list configured for this installation.",
      code: "WEB_ACCESS_RESTRICTED",
    };
  }
  return undefined;
}

export async function runWebFetch(
  rawUrl: string,
  settings: WebToolsSettings,
  signal?: AbortSignal,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<WebFetchResult> {
  const refusal = describeWebAccessRefusal(rawUrl, settings);
  if (refusal) {
    throw new Error(refusal.message);
  }

  // Redirects are followed by hand (`redirect: "manual"` below) rather than by
  // `fetch` itself, so every hop's target can be checked against the allowlist
  // BEFORE the request goes out — a disallowed host must never be contacted at
  // all, not merely have its response discarded after the fact.
  let currentUrl = rawUrl;

  for (let hop = 0; ; hop += 1) {
    if (hop > MAX_REDIRECTS) {
      throw new Error(`The page redirected more than ${MAX_REDIRECTS} times.`);
    }

    const outcome = await fetchWithBudget<FetchHopOutcome>(
      currentUrl,
      {
        method: "GET",
        headers: { "User-Agent": USER_AGENT, Accept: "text/html,text/plain,*/*" },
        redirect: "manual",
      },
      signal,
      timeoutMs,
      async (response) => {
        if (isRedirectStatus(response.status)) {
          // No content to read on a redirect, but release the connection
          // promptly rather than leaving it dangling until GC.
          await response.body?.cancel();
          return { kind: "redirect", status: response.status, location: response.headers.get("location") };
        }
        if (!response.ok) {
          throw new Error(`The page could not be loaded (HTTP ${response.status}).`);
        }

        const contentType = response.headers.get("content-type") ?? "";
        if (/^(image|audio|video|application\/(pdf|zip|octet-stream))/i.test(contentType)) {
          // Decoding a binary body as text is how you get a confidently wrong
          // answer over mojibake. Refuse clearly instead.
          await response.body?.cancel();
          throw new Error(
            `This address returns ${contentType.split(";")[0] || "binary"} content, which cannot be read as text.`,
          );
        }

        const body = await readCappedText(response);
        return { kind: "final", url: response.url || currentUrl, contentType, body };
      },
    );

    if (outcome.kind === "redirect") {
      if (!outcome.location) {
        throw new Error(`The page redirected (HTTP ${outcome.status}) without a Location header.`);
      }
      let nextUrl: string;
      try {
        nextUrl = new URL(outcome.location, currentUrl).toString();
      } catch {
        throw new Error("The page redirected to an invalid address.");
      }
      if (!isHttpUrl(nextUrl)) {
        throw new Error("The page redirected to a non-http(s) address.");
      }
      if (!isHostAllowed(nextUrl, settings.allowedDomains)) {
        throw new Error("The address redirected outside the allowed domain list.");
      }
      currentUrl = nextUrl;
      continue;
    }

    const isHtml = /html/i.test(outcome.contentType) || /^\s*<(!doctype|html)/i.test(outcome.body.text);
    const extracted = isHtml
      ? extractReadableText(outcome.body.text, outcome.url)
      : { title: "", text: outcome.body.text.trim() };
    const truncated = outcome.body.truncated || extracted.text.length > MAX_EXTRACT_CHARS;
    const cappedText = extracted.text.slice(0, MAX_EXTRACT_CHARS);

    // Cached under the FINAL url (post-redirect), so `web_read` — which never
    // fetches — can serve later sections of exactly what this call retrieved.
    const snapshot = cacheWebFetch({
      url: outcome.url,
      title: extracted.title,
      text: cappedText,
      complete: !truncated,
      charLimit: MAX_EXTRACT_CHARS,
    });

    return { url: outcome.url, title: extracted.title, text: cappedText, truncated, snapshot };
  }
}

async function readCappedText(response: Response): Promise<{ readonly text: string; readonly truncated: boolean }> {
  const { bytes, truncated } = await readCappedBytes(response, MAX_FETCH_BYTES);
  const charset = /charset=([\w-]+)/i.exec(response.headers.get("content-type") ?? "")?.[1];
  return { text: decodeBody(bytes, charset), truncated };
}

/**
 * Decodes with the declared charset when possible. This matters well beyond
 * edge cases here: a lot of Chinese technical material is still served as GB
 * 18030/GBK, and decoding it as UTF-8 produces mojibake that reads to the model
 * as plausible-but-wrong text rather than as an obvious failure.
 */
function decodeBody(buffer: Uint8Array, charset: string | undefined): string {
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
 * as line breaks, keep table row/column relationships and link hrefs, keep
 * heading levels, unescape entities, and collapse the whitespace storm that
 * results. Deliberately dependency-free — an intranet deployment should not
 * grow a parser dependency (and its update cadence) just to read a page.
 *
 * `baseUrl`, when given, is the page's own final URL (post-redirect) and is
 * used to resolve relative `<a href>` targets the way a browser would.
 *
 * Tables and links are converted to plain text BEFORE the generic tag strip
 * below runs, because that strip discards attributes (hrefs) and loses the
 * distinction between a header cell and a data cell. Doing it in this order
 * also means a link inside a table cell keeps its URL: the link pass runs
 * first and leaves plain "text (url)" text sitting inside the still-tagged
 * table, which the table pass then treats as ordinary cell content.
 */
export function extractReadableText(html: string, baseUrl?: string): { readonly title: string; readonly text: string } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? decodeEntities(stripTags(titleMatch[1] ?? "")).trim() : "";

  let working = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|canvas|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(nav|header|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");

  working = convertLinks(working, baseUrl);
  working = convertTables(working);
  working = convertHeadings(working);

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

/**
 * Replaces `<a href>` with plain "text (absolute-url)", so the link survives
 * the generic tag strip below instead of disappearing along with its href.
 * A link with no usable destination — unparseable, or a dangerous scheme —
 * keeps its visible text (still real page content) but drops the URL.
 */
function convertLinks(html: string, baseUrl: string | undefined): string {
  return html.replace(
    /<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi,
    (_match, _quote: string, href: string, inner: string) => {
      const text = cleanInlineText(inner);
      const resolved = resolveLinkUrl(href, baseUrl);
      if (!resolved) {
        return text;
      }
      return text ? `${text} (${resolved})` : resolved;
    },
  );
}

/** Resolves against `baseUrl` and rejects anything that is not http(s) —
 * `javascript:`, `data:`, `file:`, and friends are not destinations a model
 * should ever be handed as if they were a citable source. */
function resolveLinkUrl(href: string, baseUrl: string | undefined): string | undefined {
  const raw = decodeEntities(href).trim();
  if (!raw) {
    return undefined;
  }
  let resolved: URL;
  try {
    resolved = new URL(raw, baseUrl);
  } catch {
    return undefined;
  }
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
    return undefined;
  }
  return resolved.toString();
}

/** Matches an attribute value of 2 or more — i.e. an actual merge, not the
 * default `colspan="1"` some generators emit unnecessarily. */
const MEANINGFUL_SPAN = /\b(?:colspan|rowspan)\s*=\s*["']?\s*(\d+)/gi;

function hasMergedCells(tableInnerHtml: string): boolean {
  MEANINGFUL_SPAN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MEANINGFUL_SPAN.exec(tableInnerHtml))) {
    if (Number.parseInt(match[1] ?? "1", 10) > 1) {
      return true;
    }
  }
  return false;
}

interface TableCell {
  readonly text: string;
  readonly isHeader: boolean;
}

function extractRowCells(rowHtml: string): TableCell[] {
  const cells: TableCell[] = [];
  const cellPattern = /<(th|td)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let match: RegExpExecArray | null;
  while ((match = cellPattern.exec(rowHtml))) {
    cells.push({
      isHeader: (match[1] ?? "").toLowerCase() === "th",
      text: cleanInlineText(match[2] ?? ""),
    });
  }
  return cells;
}

/**
 * Renders one `<table>`'s inner HTML as text that keeps each value bound to
 * both its column header and its row, so a model reading only a later part
 * of a truncated table still knows what each number refers to — unlike a
 * flattened wall of numbers, which reads as plausible even once row/column
 * correspondence has been lost. Chosen over a Markdown grid for the same
 * reason: a Markdown table's header only appears once, at the top, so a row
 * that lands in a later part (after truncation or pagination) is silently
 * unlabeled; repeating the header inline on every row survives that.
 *
 * `colspan`/`rowspan` break the simple "row N, column N" mapping this relies
 * on — a spanned cell does not belong to one column/row index. Rather than
 * guess (and risk pairing a value with the wrong header), such a table is
 * rendered as raw per-row cell text with an explicit warning instead.
 */
function renderTable(tableInnerHtml: string): string {
  const rows: TableCell[][] = [];
  const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let match: RegExpExecArray | null;
  while ((match = rowPattern.exec(tableInnerHtml))) {
    const cells = extractRowCells(match[1] ?? "");
    if (cells.length > 0) {
      rows.push(cells);
    }
  }
  if (rows.length === 0) {
    return "";
  }

  if (hasMergedCells(tableInnerHtml)) {
    const lines = rows.map((row) => row.map((cell) => cell.text).filter(Boolean).join(" | "));
    return [
      "[Table structure uncertain — merged cells (colspan/rowspan) present; " +
        "values below are listed in source order and are NOT reliably aligned to column/row headers.]",
      ...lines,
    ].join("\n");
  }

  const firstRowIsHeader = rows[0]!.every((cell) => cell.isHeader);
  const headerCells = firstRowIsHeader ? rows[0] : undefined;
  const dataRows = firstRowIsHeader ? rows.slice(1) : rows;

  const lines: string[] = [];
  dataRows.forEach((row, index) => {
    let rowLabel: string | undefined;
    let startIndex = 0;
    // A row whose own first cell is a <th> is row-labeled (e.g. a stub
    // column), not just another data column.
    if (row[0]?.isHeader) {
      rowLabel = row[0].text;
      startIndex = 1;
    }
    const fields: string[] = [];
    for (let i = startIndex; i < row.length; i += 1) {
      const headerName = headerCells?.[i]?.text || `col ${i + 1}`;
      fields.push(`${headerName}=${row[i]!.text}`);
    }
    if (fields.length > 0) {
      lines.push(`${rowLabel ?? `Row ${index + 1}`}: ${fields.join("; ")}`);
    }
  });
  return lines.join("\n");
}

function convertTables(html: string): string {
  return html.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_match, inner: string) => renderTable(inner));
}

/** Keeps heading levels as Markdown-style `#` prefixes (1-6 of them) instead
 * of collapsing every `<h1>`-`<h6>` to an indistinguishable line break, so
 * downstream pagination (see `web-content-cache.ts`) can prefer to cut a long
 * page at a heading boundary rather than mid-section. */
function convertHeadings(html: string): string {
  return html.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_match, level: string, inner: string) => {
    const text = cleanInlineText(inner);
    return text ? `\n${"#".repeat(Number.parseInt(level, 10))} ${text}\n` : "\n";
  });
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, " ");
}

/**
 * Inline HTML to a single clean line: drop tags, collapse the whitespace that
 * markup indentation leaves behind, trim. Used wherever a fragment has to end
 * up on one line — link text, table cells, headings.
 */
function cleanInlineText(html: string): string {
  return stripTags(html).replace(/\s+/g, " ").trim();
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

function numberField(value: unknown, key: string): number | undefined {
  const field = pick(value, key);
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
