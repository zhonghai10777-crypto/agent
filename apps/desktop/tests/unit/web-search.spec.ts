import { expect, test } from "@playwright/test";
import {
  DEFAULT_WEB_TOOLS_SETTINGS,
  describeWebToolsMisconfiguration,
  extractReadableText,
  isDeepSeekEndpoint,
  isHostAllowed,
  isHttpUrl,
  normalizeWebToolsSettings,
  parseDeepSeekSearchResults,
} from "../../electron/web-search";
import { canBorrowModelProviderKey } from "../../src/web-search-providers";

test("extractReadableText drops scripts, styles and chrome, keeping body prose", () => {
  const html = `<!doctype html><html><head><title>GB/T 14100 — 风电机组</title>
    <style>.a{color:red}</style><script>var x = "<p>not content</p>";</script></head>
    <body><nav><a href="/">首页</a></nav>
      <h1>锅炉效率</h1><p>第 3.2 条：额定负荷下效率不低于 92%。</p>
      <p>备注&nbsp;&mdash;&nbsp;见附录 A。</p>
      <footer>版权所有</footer></body></html>`;

  const { title, text } = extractReadableText(html);

  expect(title).toBe("GB/T 14100 — 风电机组");
  expect(text).toContain("锅炉效率");
  expect(text).toContain("第 3.2 条：额定负荷下效率不低于 92%。");
  // Entities are decoded rather than leaking &nbsp;/&mdash; into the model's input.
  expect(text).toContain("备注 — 见附录 A。");
  // Script/style bodies and page chrome must not reach the model as "content".
  expect(text).not.toContain("not content");
  expect(text).not.toContain("color:red");
  expect(text).not.toContain("首页");
  expect(text).not.toContain("版权所有");
  // No tag residue and no runaway blank lines.
  expect(text).not.toMatch(/<[a-z]/i);
  expect(text).not.toMatch(/\n{3,}/);
});

test("extractReadableText keeps block boundaries as line breaks", () => {
  const { text } = extractReadableText("<body><p>第一段</p><p>第二段</p><li>要点</li></body>");
  expect(text.split("\n")).toEqual(["第一段", "第二段", "要点"]);
});

test("isHostAllowed matches host and subdomains but never bare substrings", () => {
  const allow = ["example.com", "intranet.local"];

  expect(isHostAllowed("https://example.com/a", allow)).toBe(true);
  expect(isHostAllowed("https://docs.example.com/a", allow)).toBe(true);
  expect(isHostAllowed("http://intranet.local/wiki", allow)).toBe(true);

  // The lookalike cases an endsWith-on-the-whole-URL check would wrongly allow.
  expect(isHostAllowed("https://evil-example.com/a", allow)).toBe(false);
  expect(isHostAllowed("https://attacker.net/?q=example.com", allow)).toBe(false);
  expect(isHostAllowed("https://example.com.attacker.net/a", allow)).toBe(false);
  expect(isHostAllowed("not a url", allow)).toBe(false);

  // Empty allowlist means unrestricted.
  expect(isHostAllowed("https://anything.test/x", [])).toBe(true);
});

test("isHttpUrl accepts only http and https", () => {
  expect(isHttpUrl("http://a.test")).toBe(true);
  expect(isHttpUrl("https://a.test")).toBe(true);
  expect(isHttpUrl("file:///C:/secrets.txt")).toBe(false);
  expect(isHttpUrl("javascript:alert(1)")).toBe(false);
  expect(isHttpUrl("a.test")).toBe(false);
});

test("normalizeWebToolsSettings clamps and sanitizes untrusted input", () => {
  const normalized = normalizeWebToolsSettings({
    enabled: "yes",
    provider: "not-a-provider",
    apiKey: "  key  ",
    maxResults: 999,
    allowedDomains: ["  .Example.COM ", "", 42, "intranet.local"],
  });

  // Only an exact `true` enables it — a truthy string must not turn on network access.
  expect(normalized.enabled).toBe(false);
  expect(normalized.provider).toBe(DEFAULT_WEB_TOOLS_SETTINGS.provider);
  expect(normalized.apiKey).toBe("key");
  expect(normalized.maxResults).toBe(20);
  expect(normalized.allowedDomains).toEqual(["example.com", "intranet.local"]);
});

test("describeWebToolsMisconfiguration explains what to fix, per provider", () => {
  expect(describeWebToolsMisconfiguration(DEFAULT_WEB_TOOLS_SETTINGS)).toContain("turned off");

  const noKey = normalizeWebToolsSettings({ enabled: true, provider: "bocha" });
  expect(describeWebToolsMisconfiguration(noKey)).toContain("API key");

  const withKey = normalizeWebToolsSettings({ enabled: true, provider: "bocha", apiKey: "k" });
  expect(describeWebToolsMisconfiguration(withKey)).toBeUndefined();

  const searxngNoUrl = normalizeWebToolsSettings({ enabled: true, provider: "searxng" });
  expect(describeWebToolsMisconfiguration(searxngNoUrl)).toContain("SearXNG");

  const searxngBadUrl = normalizeWebToolsSettings({
    enabled: true,
    provider: "searxng",
    searxngBaseUrl: "ftp://nope",
  });
  expect(describeWebToolsMisconfiguration(searxngBadUrl)).toContain("valid http(s)");

  // SearXNG needs no key at all.
  const searxngOk = normalizeWebToolsSettings({
    enabled: true,
    provider: "searxng",
    searxngBaseUrl: "http://searx.intranet.local",
  });
  expect(describeWebToolsMisconfiguration(searxngOk)).toBeUndefined();
});

test("deepseek is a valid provider and can borrow the model credential", () => {
  expect(normalizeWebToolsSettings({ provider: "deepseek" }).provider).toBe("deepseek");
  expect(canBorrowModelProviderKey("deepseek")).toBe(true);
  expect(canBorrowModelProviderKey("bocha")).toBe(false);
  expect(canBorrowModelProviderKey("searxng")).toBe(false);
});

test("a custom endpoint on DeepSeek's API is recognized whatever its provider id", () => {
  // A user may reach DeepSeek through a custom endpoint named anything at all,
  // so search claims the key by base URL rather than by provider id.
  expect(isDeepSeekEndpoint("https://api.deepseek.com/v1")).toBe(true);
  expect(isDeepSeekEndpoint("https://api.deepseek.com")).toBe(true);
  expect(isDeepSeekEndpoint("https://api.deepseek.com/anthropic/v1/messages")).toBe(true);
  // Subdomains of the real host count; look-alikes must not.
  expect(isDeepSeekEndpoint("https://gateway.api.deepseek.com/v1")).toBe(true);
  expect(isDeepSeekEndpoint("https://api.deepseek.com.attacker.net/v1")).toBe(false);
  expect(isDeepSeekEndpoint("https://deepseek.example.com/v1")).toBe(false);
  expect(isDeepSeekEndpoint("http://localhost:11434/v1")).toBe(false);
  expect(isDeepSeekEndpoint("not a url")).toBe(false);
  expect(isDeepSeekEndpoint("")).toBe(false);
});

test("describeWebToolsMisconfiguration points deepseek users at a field that exists", () => {
  const noKey = normalizeWebToolsSettings({ enabled: true, provider: "deepseek" });
  const message = describeWebToolsMisconfiguration(noKey);
  // Web access owns the key field for every backend, so it is named first;
  // Providers is mentioned second because the borrow path is also valid.
  expect(message).toContain("Web access");
  expect(message).toContain("Providers");

  // Whether typed here or borrowed by main, a present key makes the config valid.
  const bound = normalizeWebToolsSettings({ enabled: true, provider: "deepseek", apiKey: "sk-test" });
  expect(describeWebToolsMisconfiguration(bound)).toBeUndefined();
});

/**
 * Mirrors a real `api.deepseek.com/anthropic/v1/messages` reply: reasoning and
 * commentary blocks interleaved with the search results, a repeated source, and
 * a second search that failed.
 *
 * The failed sub-search's `content` is a BARE error object, not an array —
 * that is DeepSeek's documented failure shape for `web_search_tool_result`,
 * matching the Anthropic protocol it mirrors.
 */
const DEEPSEEK_RESPONSE = {
  type: "message",
  stop_reason: "max_tokens",
  usage: { server_tool_use: { web_search_requests: 2 } },
  content: [
    { type: "thinking", thinking: "The user wants a standard. Let me search." },
    { type: "server_tool_use", id: "call_00", name: "web_search", input: { query: "锅炉效率 标准" } },
    {
      type: "web_search_tool_result",
      tool_use_id: "call_00",
      content: [
        {
          type: "web_search_result",
          title: "GB/T 10184-2025：电站锅炉性能试验规程",
          url: "https://std.samr.gov.cn/hb/search/stdHBDetailed?id=2FA2",
          page_age: "2025-03-11",
          encrypted_content: "EqGZ+Sls0jp3h5EnzsKGkOUdyPSDXAi02S8",
        },
        // Same source surfaced twice in one turn — must collapse to one result.
        {
          type: "web_search_result",
          title: "GB/T 10184-2025（重复）",
          url: "https://std.samr.gov.cn/hb/search/stdHBDetailed?id=2FA2",
          encrypted_content: "dup",
        },
        { type: "web_search_result", title: "行业标准信息服务平台", url: "https://hbba.sacinfo.org.cn/stdDetail/ae96" },
        // A source with no URL cannot be fetched, so it is not a usable result.
        { type: "web_search_result", title: "无链接条目" },
      ],
    },
    { type: "text", text: "根据检索结果……" },
    {
      type: "web_search_tool_result",
      tool_use_id: "call_01",
      content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" },
    },
  ],
};

test("parseDeepSeekSearchResults harvests sources, ignores surrounding blocks, and keeps page_age/stop_reason/usage", () => {
  const outcome = parseDeepSeekSearchResults(DEEPSEEK_RESPONSE);

  expect(outcome.results.map((result) => result.url)).toEqual([
    "https://std.samr.gov.cn/hb/search/stdHBDetailed?id=2FA2",
    "https://hbba.sacinfo.org.cn/stdDetail/ae96",
  ]);
  expect(outcome.results[0]?.title).toBe("GB/T 10184-2025：电站锅炉性能试验规程");
  // DeepSeek keeps the page text in an opaque field, so there is no snippet —
  // and the encrypted blob must never be passed off as one.
  expect(outcome.results[0]?.snippet).toBe("");
  expect(outcome.results[1]?.snippet).toBe("");
  expect(JSON.stringify(outcome.results)).not.toContain("EqGZ");
  // page_age is kept verbatim, not parsed — and absent when DeepSeek omits it.
  expect(outcome.results[0]?.pageAge).toBe("2025-03-11");
  expect(outcome.results[1]?.pageAge).toBeUndefined();
  // stop_reason and the server-side search count are propagated, not dropped.
  expect(outcome.stopReason).toBe("max_tokens");
  expect(outcome.webSearchRequests).toBe(2);
});

test("parseDeepSeekSearchResults keeps sources from a partially failed multi-search turn", () => {
  // One bad search among several must not discard the sources the others found.
  expect(parseDeepSeekSearchResults(DEEPSEEK_RESPONSE).results).toHaveLength(2);
});

test("parseDeepSeekSearchResults surfaces the error code when every search failed, instead of returning empty", () => {
  const allFailed = {
    content: [
      {
        type: "web_search_tool_result",
        // Bare error object — the real DeepSeek/Anthropic failure shape. The
        // old parser's `Array.isArray` guard silently swallowed exactly this,
        // so the user only ever saw "No results found".
        content: { type: "web_search_tool_result_error", error_code: "invalid_tool_input" },
      },
    ],
  };
  expect(() => parseDeepSeekSearchResults(allFailed)).toThrow(/invalid_tool_input/);
});

test("parseDeepSeekSearchResults reports that no search ran, distinctly from an empty result", () => {
  // No `content` array at all, or an array with no web_search_tool_result
  // block in it — the model never called the tool. This must not read to the
  // caller the same as "searched and found nothing".
  const noSearchMessage = /did not perform a web search/;
  expect(() => parseDeepSeekSearchResults({})).toThrow(noSearchMessage);
  expect(() => parseDeepSeekSearchResults(undefined)).toThrow(noSearchMessage);
  expect(() => parseDeepSeekSearchResults({ content: "not an array" })).toThrow(noSearchMessage);
  expect(() => parseDeepSeekSearchResults({ content: [{ type: "text", text: "no search needed" }] })).toThrow(
    noSearchMessage,
  );
});

test("parseDeepSeekSearchResults treats a legitimate empty result list as success, not an error", () => {
  const outcome = parseDeepSeekSearchResults({
    content: [{ type: "web_search_tool_result", content: [] }],
  });
  expect(outcome.results).toEqual([]);
});

test("parseDeepSeekSearchResults reports an unrecognized result shape instead of silently returning nothing", () => {
  const unrecognizedMessage = /does not recognize/;
  expect(() =>
    parseDeepSeekSearchResults({ content: [{ type: "web_search_tool_result", content: null }] }),
  ).toThrow(unrecognizedMessage);
  expect(() =>
    parseDeepSeekSearchResults({ content: [{ type: "web_search_tool_result", content: "oops" }] }),
  ).toThrow(unrecognizedMessage);
});

test("parseDeepSeekSearchResults leaves stop_reason/webSearchRequests undefined rather than defaulting usage to 0", () => {
  const outcome = parseDeepSeekSearchResults({
    content: [{ type: "web_search_tool_result", content: [] }],
  });
  expect(outcome.stopReason).toBeUndefined();
  expect(outcome.webSearchRequests).toBeUndefined();
});
