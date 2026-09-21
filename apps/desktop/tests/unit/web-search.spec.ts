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
  runWebSearch,
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

test("extractReadableText keeps table values bound to their column header and row", () => {
  const html = `<table>
    <tr><th>工况</th><th>转速(rpm)</th><th>功率(kW)</th></tr>
    <tr><td>A</td><td>1500</td><td>100</td></tr>
    <tr><td>B</td><td>3000</td><td>200</td></tr>
  </table>`;

  const { text } = extractReadableText(html);

  // The value must appear bound to BOTH its column header and its row
  // identity in the same line — two unrelated strings of numbers would not
  // let a model reading only this line recover which reading belongs to
  // which condition.
  const rowA = text.split("\n").find((line) => line.includes("工况=A"));
  expect(rowA).toBeDefined();
  expect(rowA).toContain("转速(rpm)=1500");
  expect(rowA).toContain("功率(kW)=100");

  const rowB = text.split("\n").find((line) => line.includes("工况=B"));
  expect(rowB).toBeDefined();
  expect(rowB).toContain("转速(rpm)=3000");
  expect(rowB).toContain("功率(kW)=200");
});

test("extractReadableText marks a merged-cell table as structurally uncertain instead of guessing", () => {
  const html = `<table>
    <tr><th colspan="2">合并表头</th></tr>
    <tr><td>1500</td><td>3000</td></tr>
  </table>`;

  const { text } = extractReadableText(html);

  expect(text).toContain("uncertain");
  // The raw values are still present — dropped structure, not dropped data.
  expect(text).toContain("1500");
  expect(text).toContain("3000");
  // Must NOT have been flattened into a false header=value binding.
  expect(text).not.toMatch(/=\s*1500/);
});

test("extractReadableText resolves a relative link against the page's final URL", () => {
  const html = `<body><p><a href="../spec.pdf">规范文档</a></p></body>`;

  const { text } = extractReadableText(html, "https://x.test/docs/a.html");

  expect(text).toContain("https://x.test/spec.pdf");
  expect(text).toContain("规范文档");
});

test("extractReadableText drops javascript: links but keeps their visible text", () => {
  const html = `<body><p><a href="javascript:alert(1)">点击此处</a></p></body>`;

  const { text } = extractReadableText(html, "https://x.test/a.html");

  expect(text).not.toContain("javascript:");
  expect(text).toContain("点击此处");
});

test("extractReadableText keeps heading levels as # prefixes", () => {
  const html = `<body><h1>一级标题</h1><h2>二级标题</h2><p>正文</p></body>`;

  const { text } = extractReadableText(html);

  expect(text).toContain("# 一级标题");
  expect(text).toContain("## 二级标题");
  expect(text).toContain("正文");
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

test("normalizeWebToolsSettings validates the DeepSeek request-shaping fields instead of letting them through unbounded", () => {
  const illegal = normalizeWebToolsSettings({
    deepseekMaxTokens: NaN,
    deepseekMaxUses: Infinity,
    deepseekModel: "   ",
  });
  expect(illegal.deepseekMaxTokens).toBe(DEFAULT_WEB_TOOLS_SETTINGS.deepseekMaxTokens);
  expect(illegal.deepseekMaxUses).toBe(DEFAULT_WEB_TOOLS_SETTINGS.deepseekMaxUses);
  expect(illegal.deepseekModel).toBe(DEFAULT_WEB_TOOLS_SETTINGS.deepseekModel);

  // Out-of-range values are clamped to the boundary, the same policy
  // `maxResults` already uses — not silently accepted as "no limit".
  const outOfRange = normalizeWebToolsSettings({ deepseekMaxTokens: 999_999, deepseekMaxUses: -5 });
  expect(outOfRange.deepseekMaxTokens).toBe(16_384);
  expect(outOfRange.deepseekMaxUses).toBe(1);

  // A float is truncated to an integer, not rejected outright.
  const float = normalizeWebToolsSettings({ deepseekMaxTokens: 1000.9 });
  expect(float.deepseekMaxTokens).toBe(1000);

  const custom = normalizeWebToolsSettings({ deepseekModel: "deepseek-v4-pro" });
  expect(custom.deepseekModel).toBe("deepseek-v4-pro");

  // No non-finite or negative input may escape as an unbounded/invalid value.
  for (const bad of [NaN, Infinity, -Infinity, -1, 0]) {
    const normalized = normalizeWebToolsSettings({ deepseekMaxUses: bad });
    expect(Number.isFinite(normalized.deepseekMaxUses)).toBe(true);
    expect(normalized.deepseekMaxUses).toBeGreaterThanOrEqual(1);
    expect(normalized.deepseekMaxUses).toBeLessThanOrEqual(10);
  }
});

test("normalizeWebToolsSettings migrates an old settings file that predates the DeepSeek fields", () => {
  // Shape of a web-tools.json written before deepseekModel/MaxTokens/MaxUses
  // existed. Reading it back must not throw and must not lose maxResults.
  const legacyFile = { enabled: true, provider: "deepseek", apiKey: "sk-x", maxResults: 8, allowedDomains: [] };
  const normalized = normalizeWebToolsSettings(legacyFile);

  expect(normalized.deepseekModel).toBe(DEFAULT_WEB_TOOLS_SETTINGS.deepseekModel);
  expect(normalized.deepseekMaxTokens).toBe(DEFAULT_WEB_TOOLS_SETTINGS.deepseekMaxTokens);
  expect(normalized.deepseekMaxUses).toBe(DEFAULT_WEB_TOOLS_SETTINGS.deepseekMaxUses);
  // The migration must not clobber a value the user already had saved.
  expect(normalized.maxResults).toBe(8);
});

test("DEFAULT_WEB_TOOLS_SETTINGS.maxResults defaults to 10 but never overrides a value the user already saved", () => {
  // Measured against a real DeepSeek key: one search call returns 10 sources
  // and is billed per call, not per result, so the old default of 5 silently
  // discarded half of what had already been paid for.
  expect(DEFAULT_WEB_TOOLS_SETTINGS.maxResults).toBe(10);
  expect(normalizeWebToolsSettings({}).maxResults).toBe(10);

  // A user who already had 5 saved (the old default, written to disk before
  // this change) must keep exactly that value, not get silently bumped to 10.
  expect(normalizeWebToolsSettings({ maxResults: 5 }).maxResults).toBe(5);
});

/**
 * Runs `run` with `globalThis.fetch` replaced by a stub that records the
 * request init and answers with an empty-but-well-formed DeepSeek search
 * result (so `parseDeepSeekSearchResults` doesn't itself throw), restoring
 * the real `fetch` afterward regardless of outcome. Used by the request-body
 * wiring tests below, which care about what DeepSeek was ASKED, not what it
 * answered.
 */
async function withMockedFetch(run: () => Promise<void>): Promise<{ readonly body?: string }> {
  const originalFetch = globalThis.fetch;
  let capturedInit: { readonly body?: string } = {};
  globalThis.fetch = (async (_url: string, init: { readonly body?: string }) => {
    capturedInit = init;
    return new Response(JSON.stringify({ content: [{ type: "web_search_tool_result", content: [] }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
  return capturedInit;
}

test("deepseek search sends the configured model/maxTokens/maxUses and pushes allowedDomains to the server", async () => {
  const settings = normalizeWebToolsSettings({
    enabled: true,
    provider: "deepseek",
    apiKey: "sk-test",
    deepseekModel: "deepseek-v4-pro",
    deepseekMaxTokens: 2048,
    deepseekMaxUses: 7,
    allowedDomains: ["example.com", "intranet.local"],
  });
  const capturedInit = await withMockedFetch(() => runWebSearch("锅炉效率", settings).then(() => undefined));

  const body = JSON.parse(capturedInit.body ?? "{}");
  expect(body.model).toBe("deepseek-v4-pro");
  expect(body.max_tokens).toBe(2048);
  expect(body.tools[0].max_uses).toBe(7);
  expect(body.tools[0].allowed_domains).toEqual(["example.com", "intranet.local"]);
});

test("deepseek search omits allowed_domains from the request when no allowlist is configured", async () => {
  const settings = normalizeWebToolsSettings({ enabled: true, provider: "deepseek", apiKey: "sk-test" });
  const capturedInit = await withMockedFetch(() => runWebSearch("锅炉效率", settings).then(() => undefined));

  const body = JSON.parse(capturedInit.body ?? "{}");
  expect(body.tools[0]).not.toHaveProperty("allowed_domains");
});
