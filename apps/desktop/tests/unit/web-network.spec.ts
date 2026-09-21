import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import { runWebFetch, runWebSearch, normalizeWebToolsSettings, type WebToolsSettings } from "../../electron/web-search";
import { createWebRuntimeTools, webFetchToolName, webReadToolName } from "../../electron/web-runtime";
import { resetWebContentCacheForTests } from "../../electron/web-content-cache";

/**
 * Exercises the real network path (search request → parse → allowlist filter,
 * and fetch → charset decode → readability) against a local stand-in for a
 * SearXNG instance and a content site. No live third-party service involved.
 */
async function startServer(
  handler: (url: URL, respond: (status: number, headers: Record<string, string>, body: Buffer | string) => void) => void,
): Promise<{ readonly baseUrl: string; readonly close: () => Promise<void> }> {
  return startRawServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    handler(url, (status, headers, body) => {
      response.writeHead(status, headers);
      response.end(body);
    });
  });
}

/**
 * Same as `startServer` but hands the handler the raw request/response so it
 * can stream a body, stall it, or watch for the client disconnecting —
 * things the respond-once helper above cannot express.
 */
async function startRawServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ readonly baseUrl: string; readonly close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // Force-drop any lingering sockets (e.g. a body the client never
        // finished reading) instead of waiting for them to close naturally —
        // otherwise a stalled-body test would hang `server.close()` forever.
        server.closeAllConnections?.();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
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

test("web_fetch blocks a redirect that leaves the allowlist, and never contacts that host at all", async () => {
  let outsideHitCount = 0;
  const outside = await startServer((_url, respond) => {
    outsideHitCount += 1;
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
    // The redirect target must be checked BEFORE it is requested — the
    // disallowed server must never receive a single request, not merely have
    // its response discarded after the fact.
    expect(outsideHitCount).toBe(0);

    // Control: without the redirect, the same allowlist permits the fetch.
    const direct = await runWebFetch(`${outside.baseUrl}/x`, settings);
    expect(direct.text).toContain("leaked");
    expect(outsideHitCount).toBe(1);
  } finally {
    await inside.close();
    await outside.close();
  }
});

test("web_fetch stops downloading once the hard byte cap is crossed, and the server observes the disconnect", async () => {
  const CHUNK = Buffer.alloc(64 * 1024, 0x61); // 64KiB of 'a'
  const INTENDED_CHUNKS = 200; // 200 * 64KiB ≈ 12.5MiB — well past the 5MiB cap.
  let chunksWritten = 0;
  let serverSawClose = false;

  const server = await startRawServer((_request, response) => {
    // No Content-Length: this is exactly the chunked-transfer, unknown-size
    // case where a buffer-then-slice cap does nothing to bound the download.
    response.writeHead(200, { "Content-Type": "text/html" });
    response.on("close", () => {
      serverSawClose = true;
    });
    const timer = setInterval(() => {
      if (serverSawClose || chunksWritten >= INTENDED_CHUNKS) {
        clearInterval(timer);
        if (!serverSawClose) {
          response.end();
        }
        return;
      }
      chunksWritten += 1;
      response.write(CHUNK);
    }, 1);
  });

  try {
    const settings = normalizeWebToolsSettings({ enabled: true, provider: "searxng", searxngBaseUrl: server.baseUrl });
    const page = await runWebFetch(`${server.baseUrl}/firehose`, settings);

    // The extracted text is capped well below what 200 chunks would produce.
    expect(page.truncated).toBe(true);
    expect(page.text.length).toBeLessThan(CHUNK.length * INTENDED_CHUNKS);

    // The server must actually have seen the client hang up early — proof the
    // cap stopped the transfer in flight, not just truncated it after the
    // fact once the whole body had already been downloaded.
    const deadline = Date.now() + 2000;
    while (!serverSawClose && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(serverSawClose).toBe(true);
    expect(chunksWritten).toBeLessThan(INTENDED_CHUNKS);
  } finally {
    await server.close();
  }
});

test("the overall timeout still fires when headers arrive but the body never ends", async () => {
  const server = await startRawServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.write("<html><body><p>partial and stuck");
    // Deliberately never call response.end() — the body stalls forever, which
    // is the case a header-only timeout cannot catch.
  });

  try {
    const settings = normalizeWebToolsSettings({ enabled: true, provider: "searxng", searxngBaseUrl: server.baseUrl });
    const start = Date.now();
    // A short injected timeout so the test does not wait anywhere near the
    // real 20s production default.
    await expect(runWebFetch(`${server.baseUrl}/stall`, settings, undefined, 200)).rejects.toThrow(/timed out/);
    expect(Date.now() - start).toBeLessThan(2000);
  } finally {
    await server.close();
  }
});

test("web tools refuse to run while web access is disabled", async () => {
  const settings = normalizeWebToolsSettings({ provider: "searxng", searxngBaseUrl: "http://x.test" });
  await expect(runWebSearch("anything", settings)).rejects.toThrow(/turned off/);
  await expect(runWebFetch("http://x.test/page", settings)).rejects.toThrow(/turned off/);
});

/**
 * The web_fetch/web_read pagination and cache-authorization behavior added
 * alongside the structural HTML extraction rewrite: a long page can be read
 * section by section without re-fetching it, but every web_read call is
 * re-checked against the LIVE settings — a cache hit must never bypass
 * "web access is off" or a narrowed domain allowlist.
 */
function webTools(getSettings: () => WebToolsSettings) {
  const tools = createWebRuntimeTools(getSettings);
  const webFetch = tools.find((tool) => tool.name === webFetchToolName);
  const webRead = tools.find((tool) => tool.name === webReadToolName);
  if (!webFetch || !webRead) {
    throw new Error("web_fetch/web_read were not registered");
  }
  return { webFetch, webRead };
}

/** A page long enough to need several ~12,000-char sections, with a unique
 * marker as the very last paragraph so a test can prove it actually reached
 * the end rather than just re-reading the first section. */
function longPageHtml(): string {
  const paragraphs = Array.from({ length: 400 }, (_, i) => `<p>Paragraph ${i}: ${"x".repeat(80)}</p>`).join("");
  return `<html><head><title>Long Page</title></head><body>${paragraphs}<p>MARKER_END_OF_PAGE</p></body></html>`;
}

test("web_read reads the final section of a long page, with the correct part/totalParts", async () => {
  resetWebContentCacheForTests();
  const server = await startServer((_url, respond) => {
    respond(200, { "Content-Type": "text/html" }, longPageHtml());
  });

  try {
    const settings = normalizeWebToolsSettings({ enabled: true, provider: "searxng", searxngBaseUrl: server.baseUrl });
    const { webFetch, webRead } = webTools(() => settings);

    const fetched = await webFetch.execute("call-fetch", { url: `${server.baseUrl}/big` }, undefined);
    const fetchedDetails = fetched.details as { url: string; part?: number; totalParts?: number };
    expect(fetchedDetails.part).toBe(1);
    expect(fetchedDetails.totalParts ?? 0).toBeGreaterThan(1);
    // The first section alone must not already contain the marker planted at
    // the very end of the page — otherwise this test would not actually be
    // proving pagination works.
    expect(fetched.content[0]?.text).not.toContain("MARKER_END_OF_PAGE");

    const lastPart = fetchedDetails.totalParts as number;
    const read = await webRead.execute("call-read", { url: fetchedDetails.url, part: lastPart }, undefined);
    expect(read.details).toMatchObject({ action: "web_read", part: lastPart, totalParts: lastPart });
    expect(read.content[0]?.text).toContain("MARKER_END_OF_PAGE");
    expect(read.content[0]?.text).toContain(`section ${lastPart} of ${lastPart}`);
    expect(read.content[0]?.text).not.toContain("More follows");
  } finally {
    await server.close();
  }
});

test("web_read rejects a stale source_version instead of serving new content under an old locator", async () => {
  resetWebContentCacheForTests();
  const server = await startServer((_url, respond) => {
    respond(200, { "Content-Type": "text/html" }, "<html><body><p>hello</p></body></html>");
  });

  try {
    const settings = normalizeWebToolsSettings({ enabled: true, provider: "searxng", searxngBaseUrl: server.baseUrl });
    const { webFetch, webRead } = webTools(() => settings);

    const fetched = await webFetch.execute("call-fetch", { url: `${server.baseUrl}/doc` }, undefined);
    const url = (fetched.details as { url: string }).url;

    const stale = await webRead.execute("call-read", { url, source_version: "0000000000000000" }, undefined);
    expect(stale.content[0]?.text).toMatch(/changed/);
    expect((stale.details as { error?: string }).error).toMatch(/changed/);
  } finally {
    await server.close();
  }
});

test("web_read is rejected once web access is turned off, without making any new network request", async () => {
  resetWebContentCacheForTests();
  let hits = 0;
  const server = await startServer((_url, respond) => {
    hits += 1;
    respond(200, { "Content-Type": "text/html" }, "<html><body><p>hello</p></body></html>");
  });

  try {
    let settings = normalizeWebToolsSettings({ enabled: true, provider: "searxng", searxngBaseUrl: server.baseUrl });
    const { webFetch, webRead } = webTools(() => settings);

    const fetched = await webFetch.execute("call-fetch", { url: `${server.baseUrl}/doc` }, undefined);
    const url = (fetched.details as { url: string }).url;
    expect(hits).toBe(1);

    // Same session, same cached URL — only the live setting changes.
    settings = normalizeWebToolsSettings({ enabled: false, provider: "searxng", searxngBaseUrl: server.baseUrl });
    const blocked = await webRead.execute("call-read", { url }, undefined);

    expect(blocked.content[0]?.text).toMatch(/turned off/);
    // The cache hit must not have been used as a way around the setting: no
    // new request was made to serve this "read".
    expect(hits).toBe(1);
  } finally {
    await server.close();
  }
});

test("web_read is rejected once a tightened domain allowlist no longer covers a cached URL", async () => {
  resetWebContentCacheForTests();
  let hits = 0;
  const server = await startServer((_url, respond) => {
    hits += 1;
    respond(200, { "Content-Type": "text/html" }, "<html><body><p>hello</p></body></html>");
  });

  try {
    let settings = normalizeWebToolsSettings({ enabled: true, provider: "searxng", searxngBaseUrl: server.baseUrl });
    const { webFetch, webRead } = webTools(() => settings);

    const fetched = await webFetch.execute("call-fetch", { url: `${server.baseUrl}/doc` }, undefined);
    const url = (fetched.details as { url: string }).url;
    expect(hits).toBe(1);

    // Tighten the allowlist to a domain that does not cover the local server.
    settings = normalizeWebToolsSettings({
      enabled: true,
      provider: "searxng",
      searxngBaseUrl: server.baseUrl,
      allowedDomains: ["example.com"],
    });
    const blocked = await webRead.execute("call-read", { url }, undefined);

    expect(blocked.content[0]?.text).toMatch(/allowed domain/);
    expect(hits).toBe(1);
  } finally {
    await server.close();
  }
});

test("web_read on a URL never fetched tells the model to use web_fetch first, and makes no network request", async () => {
  resetWebContentCacheForTests();
  let hits = 0;
  const server = await startServer((_url, respond) => {
    hits += 1;
    respond(200, { "Content-Type": "text/html" }, "<html><body><p>hello</p></body></html>");
  });

  try {
    const settings = normalizeWebToolsSettings({ enabled: true, provider: "searxng", searxngBaseUrl: server.baseUrl });
    const { webRead } = webTools(() => settings);

    const result = await webRead.execute("call-read", { url: `${server.baseUrl}/never-fetched` }, undefined);

    expect(result.content[0]?.text).toMatch(/web_fetch/);
    expect(hits).toBe(0);
  } finally {
    await server.close();
  }
});

test("web_fetch's old single-argument {url} call still works and returns section 1", async () => {
  resetWebContentCacheForTests();
  const server = await startServer((_url, respond) => {
    respond(200, { "Content-Type": "text/html" }, "<html><head><title>Hi</title></head><body><p>hello world</p></body></html>");
  });

  try {
    const settings = normalizeWebToolsSettings({ enabled: true, provider: "searxng", searxngBaseUrl: server.baseUrl });
    const { webFetch } = webTools(() => settings);

    const result = await webFetch.execute("call-fetch", { url: `${server.baseUrl}/doc` }, undefined);

    expect(result.details).toMatchObject({ action: "web_fetch", part: 1, totalParts: 1 });
    expect(result.content[0]?.text).toContain("# Hi");
    expect(result.content[0]?.text).toContain("hello world");
    expect(result.content[0]?.text).toMatch(/Source version: [0-9a-f]{16}/);
  } finally {
    await server.close();
  }
});
