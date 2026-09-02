import { expect, test } from "@playwright/test";
import { normalizeWebToolsSettings, runWebSearch } from "../../electron/web-search";

/**
 * Hits DeepSeek's live server-side search. Opt-in: set DS_KEY to a real DeepSeek
 * API key. Skipped otherwise so CI never depends on a third-party service.
 */
test("deepseek server-side search returns real sources", async () => {
  const key = process.env.DS_KEY?.trim();
  test.skip(!key, "Set DS_KEY to a real DeepSeek API key to run this spec.");
  test.setTimeout(120_000);

  const settings = normalizeWebToolsSettings({
    enabled: true,
    provider: "deepseek",
    apiKey: key,
    maxResults: 5,
  });

  const results = await runWebSearch("330MW W型锅炉 燃烧调整", settings);
  for (const [index, result] of results.entries()) {
    console.log(`${index + 1}. ${result.title}\n   ${result.url}`);
  }
  expect(results.length).toBeGreaterThan(0);
  expect(results[0]?.url).toMatch(/^https?:\/\//);
});
