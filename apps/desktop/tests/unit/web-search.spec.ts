import { expect, test } from "@playwright/test";
import {
  describeWebToolsMisconfiguration,
  extractReadableText,
  isHostAllowed,
  isHttpUrl,
  normalizeWebToolsSettings,
  DEFAULT_WEB_TOOLS_SETTINGS,
} from "../../electron/web-search";

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
