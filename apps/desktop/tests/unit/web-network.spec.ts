import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import { runWebFetch, runWebSearch, normalizeWebToolsSettings } from "../../electron/web-search";

/**
 * Exercises the real network path (search request → parse → allowlist filter,
 * and fetch → charset decode → readability) against a local stand-in for a
 * SearXNG instance and a content site. No live third-party service involved.
 */
async function startServer(
  handler: (url: URL, respond: (status: number, headers: Record<string, string>, body: Buffer | string) => void) => void,
): Promise<{ readonly baseUrl: string; readonly close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    handler(url, (status, headers, body) => {
      response.writeHead(status, headers);
      response.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

test("web_search reaches a SearXNG-shaped endpoint and maps its results", async () => {
  let receivedQuery = "";
  const server = await startServer((url, respond) => {
    receivedQuery = url.searchParams.get("q") ?? "";
    respond(200, { "Content-Type": "application/json" }, JSON.stringify({
      results: [
        { title: "锅炉效率计算方法", url: "http://docs.intranet.local/gb-14100", content: "额定负荷下效率不低于 92%。" },
        { title: "Off-limits site", url: "http://blocked.example/x", content: "should be filtered out" },
      ],
    }));
  });

  try {
    const settings = normalizeWebToolsSettings({
      enabled: true,
      provider: "searxng",
      searxngBaseUrl: server.baseUrl,
      maxResults: 5,
      allowedDomains: ["intranet.local"],
    });

    const results = await runWebSearch("锅炉效率 标准", settings);

    expect(receivedQuery).toBe("锅炉效率 标准");
    // The allowlist is applied to results too, not just to fetches.
    expect(results).toHaveLength(1);
    expect(results[0]?.title).toBe("锅炉效率计算方法");
    expect(results[0]?.url).toBe("http://docs.intranet.local/gb-14100");
    expect(results[0]?.snippet).toContain("92%");
  } finally {
    await server.close();
  }
});

test("web_fetch decodes a GBK page instead of returning mojibake", async () => {
  // A lot of Chinese technical material is still served as GBK. Decoding it as
  // UTF-8 yields plausible-looking garbage the model would answer over.
  const gbkBody = Buffer.from([
    0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e, 0x3c, 0x74, 0x69, 0x74, 0x6c, 0x65, 0x3e, // <html><title>
    0xb9, 0xf8, 0xc2, 0xaf, // 锅炉
    0x3c, 0x2f, 0x74, 0x69, 0x74, 0x6c, 0x65, 0x3e, 0x3c, 0x62, 0x6f, 0x64, 0x79, 0x3e, 0x3c, 0x70, 0x3e, // </title><body><p>
    0xd0, 0xa7, 0xc2, 0xca, // 效率
    0x3c, 0x2f, 0x70, 0x3e, 0x3c, 0x2f, 0x62, 0x6f, 0x64, 0x79, 0x3e, 0x3c, 0x2f, 0x68, 0x74, 0x6d, 0x6c, 0x3e,
  ]);
  const server = await startServer((_url, respond) => {
    respond(200, { "Content-Type": "text/html; charset=gbk" }, gbkBody);
  });

  try {
    const settings = normalizeWebToolsSettings({ enabled: true, provider: "searxng", searxngBaseUrl: server.baseUrl });
    const page = await runWebFetch(`${server.baseUrl}/doc`, settings);

    expect(page.title).toBe("锅炉");
    expect(page.text).toContain("效率");
    expect(page.text).not.toContain("�");
  } finally {
    await server.close();
  }
});

test("web_fetch refuses binary content instead of decoding it as text", async () => {
  const server = await startServer((_url, respond) => {
    respond(200, { "Content-Type": "application/pdf" }, Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]));
  });

  try {
    const settings = normalizeWebToolsSettings({ enabled: true, provider: "searxng", searxngBaseUrl: server.baseUrl });
    await expect(runWebFetch(`${server.baseUrl}/manual.pdf`, settings)).rejects.toThrow(/cannot be read as text/);
  } finally {
    await server.close();
  }
});

test("web_fetch blocks a redirect that leaves the allowlist", async () => {
  const outside = await startServer((_url, respond) => {
    respond(200, { "Content-Type": "text/html" }, "<html><body><p>leaked</p></body></html>");
  });
  // Redirect to the same server via a hostname that is NOT on the allowlist.
  // `localhost` and `127.0.0.1` resolve identically but are distinct hosts, which
  // is exactly the shape of a real off-allowlist redirect.
  const outsideUrl = outside.baseUrl.replace("127.0.0.1", "localhost");
  const inside = await startServer((_url, respond) => {
    respond(302, { Location: `${outsideUrl}/x` }, "");
  });

  try {
    const settings = normalizeWebToolsSettings({
      enabled: true,
      provider: "searxng",
      searxngBaseUrl: inside.baseUrl,
      // The entry host IS allowed — so the request passes the pre-check and the
      // rejection can only come from the post-redirect host check.
      allowedDomains: ["127.0.0.1"],
    });

    await expect(runWebFetch(`${inside.baseUrl}/start`, settings)).rejects.toThrow(/redirected outside/);

    // Control: without the redirect, the same allowlist permits the fetch.
    const direct = await runWebFetch(`${outside.baseUrl}/x`, settings);
    expect(direct.text).toContain("leaked");
  } finally {
    await inside.close();
    await outside.close();
  }
});

test("web tools refuse to run while web access is disabled", async () => {
  const settings = normalizeWebToolsSettings({ provider: "searxng", searxngBaseUrl: "http://x.test" });
  await expect(runWebSearch("anything", settings)).rejects.toThrow(/turned off/);
  await expect(runWebFetch("http://x.test/page", settings)).rejects.toThrow(/turned off/);
});
