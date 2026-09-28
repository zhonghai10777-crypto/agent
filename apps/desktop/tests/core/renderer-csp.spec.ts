// The packaged renderer runs under a Content-Security-Policy (injected at
// build time, see electron.vite.config.mjs). This walks the surfaces that load
// the most varied content and fails on any violation, so a new feature that
// needs a policy change is caught here rather than breaking silently.
import { expect, test } from "@playwright/test";
import { pasteTinyPng, startThreadFromSurface } from "../helpers/electron-app";
import { launchWithCompactionFixture } from "../helpers/compaction-fixture";

test("renderer surfaces load under the production CSP without violations", async () => {
  const f = await launchWithCompactionFixture("csp-probe");
  const violations: string[] = [];
  f.page.on("console", (message) => {
    if (/Content Security Policy|Refused to/i.test(message.text())) violations.push(message.text());
  });
  f.page.on("pageerror", (error) => violations.push(`pageerror: ${error.message}`));
  try {
    f.http.setNextUsage({ prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 });
    f.http.setNextReplyText("# Heading\n\nSome **bold** text and a [link](https://example.com).\n\n```ts\nconst answer: number = 42;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n");
    await startThreadFromSurface(f.page, { prompt: "Render markdown" });
    await expect(f.page.locator(".timeline-item--assistant").last()).toContainText("const answer", { timeout: 15_000 });

    await pasteTinyPng(f.page, "probe.png");
    await expect(f.page.locator(".composer-attachment")).toHaveCount(1);

    await f.page.getByLabel("Toggle terminal").click();
    const terminal = f.page.getByTestId("integrated-terminal");
    await terminal.locator(".xterm").click();
    await f.page.keyboard.type("printf 'CSP_PROBE_OK\\n'");
    await f.page.keyboard.press("Enter");
    await expect(terminal.locator(".xterm-rows")).toContainText("CSP_PROBE_OK", { timeout: 15_000 });

    await f.page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(f.page.getByTestId("settings-surface")).toBeVisible();
    await f.page.waitForTimeout(500);
    expect(violations).toEqual([]);

    // And the policy is really enforced: injected markup cannot run script.
    await f.page.evaluate(() => {
      const script = document.createElement("script");
      script.textContent = "window.__cspProbe = 1";
      document.body.appendChild(script);
    });
    await expect.poll(() => violations.some((text) => /inline script/i.test(text))).toBe(true);
    expect(await f.page.evaluate(() => (window as { __cspProbe?: number }).__cspProbe)).toBeUndefined();
  } finally {
    await f.close();
  }
});
