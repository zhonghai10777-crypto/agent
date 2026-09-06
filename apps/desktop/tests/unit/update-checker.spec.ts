import { expect, test } from "@playwright/test";
import { checkForUpdate, resolveUpdateSource } from "../../electron/update-checker";

const json = (data: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(data), { status, headers });
const publicEnv = { PI_APP_UPDATE_REPOSITORY: "publisher/agent-releases" };
const published = [{ tag_name: "v1.1.0", html_url: "https://github.com/publisher/agent-releases/releases/tag/v1.1.0" }];

test("anonymous update checks use the distribution repository and its exact download tag", async () => {
  let request: { url: string; init: RequestInit } | undefined;
  const result = await checkForUpdate({
    env: { ...publicEnv, GH_TOKEN: "unrelated-credential" }, currentVersion: "1.0.0",
    fetch: async (url, init) => { request = { url, init }; return json(published); },
  });
  expect(request?.url).toBe("https://api.github.com/repos/publisher/agent-releases/releases?per_page=10");
  expect(new Headers(request?.init.headers).has("Authorization")).toBe(false);
  expect(request?.init.redirect).toBe("error");
  expect(result).toEqual({ status: "update-available", currentVersion: "1.0.0", latestVersion: "1.1.0", releaseUrl: published[0]!.html_url });
});

test("private updates use only the user's dedicated credential and never expose it in results", async () => {
  let authorization: string | null = null;
  const token = "user-owned-read-only-test-credential";
  const result = await checkForUpdate({
    env: { ...publicEnv, PI_APP_UPDATE_TOKEN: token }, currentVersion: "1.0.0",
    fetch: async (_url, init) => {
      authorization = new Headers(init.headers).get("Authorization");
      return json([{ tag_name: "v1.1.0", html_url: "https://elsewhere.invalid/download" }]);
    },
  });
  expect(authorization).toBe(`Bearer ${token}`);
  expect(result).toMatchObject({ status: "update-available", releaseUrl: published[0]!.html_url });
  expect(JSON.stringify(result)).not.toContain(token);
});

for (const status of [401, 403, 404]) {
  test(`HTTP ${status} reports access trouble instead of a current version`, async () => {
    const result = await checkForUpdate({ env: publicEnv, currentVersion: "1.0.0", fetch: async () => json({}, status) });
    expect(result).toMatchObject({ status: "error", code: "access-denied" });
  });
}

test("network failures, timeouts, rate limits and server errors remain distinct", async () => {
  const base = { env: publicEnv, currentVersion: "1.0.0" };
  expect(await checkForUpdate({ ...base, fetch: async () => { throw new Error("request contained a secret"); } }))
    .toMatchObject({ status: "error", code: "network" });
  expect(await checkForUpdate({ ...base, timeoutMs: 10, fetch: async (_url, init) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  }) })).toMatchObject({ status: "error", code: "timeout" });
  expect(await checkForUpdate({ ...base, fetch: async () => json({}, 403, { "x-ratelimit-remaining": "0" }) }))
    .toMatchObject({ status: "error", code: "rate-limited" });
  expect(await checkForUpdate({ ...base, fetch: async () => json({}, 500) }))
    .toMatchObject({ status: "error", code: "http" });
});

test("malformed payloads and versions are not reported as up to date", async () => {
  for (const payload of [{ message: "bad" }, null, [{ tag_name: "not-semver" }], [{ tag_name: "1.2.3-incomplete!" }]]) {
    expect(await checkForUpdate({ env: publicEnv, currentVersion: "1.0.0", fetch: async () => json(payload) }))
      .toMatchObject({ status: "error", code: "invalid-response" });
  }
  expect(await checkForUpdate({ env: publicEnv, currentVersion: "1.0.0", fetch: async () => new Response("<html>bad</html>") }))
    .toMatchObject({ status: "error", code: "invalid-response" });
  expect(await checkForUpdate({ env: publicEnv, currentVersion: "1.0.0", fetch: async () => json([]) }))
    .toMatchObject({ status: "error", code: "no-releases" });
});

test("draft releases are excluded and newer local versions stay current", async () => {
  const result = await checkForUpdate({
    env: publicEnv, currentVersion: "1.2.0",
    fetch: async () => json([{ tag_name: "v99.0.0", draft: true }, ...published]),
  });
  expect(result).toEqual({ status: "up-to-date", currentVersion: "1.2.0", latestVersion: "1.1.0" });
});

test("invalid source identifiers are rejected before a request or credential can leave the app", async () => {
  for (const repository of ["https://other.invalid/repo", "owner/repo/extra", "owner/..", "owner/repo?token=x"]) {
    expect(() => resolveUpdateSource({ PI_APP_UPDATE_REPOSITORY: repository })).toThrow(/owner\/repository/);
    let called = false;
    expect(await checkForUpdate({
      env: { PI_APP_UPDATE_REPOSITORY: repository, PI_APP_UPDATE_TOKEN: "private" },
      fetch: async () => { called = true; return json(published); },
    })).toMatchObject({ status: "error", code: "configuration" });
    expect(called).toBe(false);
  }
});
