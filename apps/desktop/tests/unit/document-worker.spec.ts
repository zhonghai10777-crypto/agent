import { mkdir, writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { DocumentWorkerClient } from "../../electron/document-worker-client";

async function fixtureWorker(file: string) {
  await writeFile(file, `import { parentPort } from 'node:worker_threads';
    parentPort.on('message', ({id, filePath}) => {
      if (filePath === 'hang') return;
      if (filePath === 'exit') process.exit(0);
      if (filePath === 'crash') throw new Error('synthetic worker failure');
      setTimeout(() => parentPort.postMessage({ id, result: { ok: true, kind: 'text', text: filePath, meta: {} } }), 30);
    });`);
  return file;
}

test("Worker timeout, queued/running cancellation, coalescing and recovery settle every request", async ({}, info) => {
  await mkdir(info.outputDir, { recursive: true });
  const client = new DocumentWorkerClient({ workerPath: await fixtureWorker(info.outputPath("worker.mjs")), maxQueue: 2 });
  try {
    const timeout = client.run("hang", "hang", { timeoutMs: 200 });
    const controller = new AbortController();
    const queued = client.run("queued", "queued", { signal: controller.signal });
    expect(await client.run("overflow", "overflow")).toMatchObject({ code: "DOCUMENT_QUEUE_FULL" });
    controller.abort();
    expect(await queued).toMatchObject({ code: "DOCUMENT_CANCELLED" });
    expect(await timeout).toMatchObject({ code: "DOCUMENT_PARSE_TIMEOUT" });
    expect(client.pendingCount).toBe(0);
    expect(await client.run("recovered", "recovered")).toMatchObject({ ok: true, text: "recovered" });
    const running = new AbortController();
    const hung = client.run("hang", "hang-again", { signal: running.signal });
    const next = client.run("next", "next");
    running.abort();
    expect(await hung).toMatchObject({ code: "DOCUMENT_CANCELLED" });
    expect(await next).toMatchObject({ ok: true, text: "next" });
    const first = new AbortController();
    let reads = 0;
    const a = client.run("shared", "shared", { signal: first.signal, readBuffer: async () => { reads++; return new Uint8Array(); } });
    const b = client.run("shared", "shared");
    first.abort();
    expect(await a).toMatchObject({ code: "DOCUMENT_CANCELLED" });
    expect(await b).toMatchObject({ ok: true, text: "shared" });
    expect(reads).toBe(1);
    expect(client.pendingCount).toBe(0);
  } finally { await client.close(); }
});

for (const action of ["exit", "crash"] as const) {
  test(`Worker ${action} settles active work and restarts for the queued document`, async ({}, info) => {
    await mkdir(info.outputDir, { recursive: true });
    const client = new DocumentWorkerClient({ workerPath: await fixtureWorker(info.outputPath("worker.mjs")) });
    try {
      const failed = client.run(action, action);
      const queued = client.run("after", "after");
      expect(await failed).toMatchObject({ code: "DOCUMENT_WORKER_UNAVAILABLE" });
      expect(await queued).toMatchObject({ ok: true, text: "after" });
      expect(client.pendingCount).toBe(0);
    } finally { await client.close(); }
  });
}

test("missing Worker returns an operational error without parsing on the caller thread", async ({}, info) => {
  const client = new DocumentWorkerClient({ workerPath: info.outputPath("missing-worker.mjs") });
  try {
    expect(await client.run("valid.txt", "version")).toMatchObject({ code: "DOCUMENT_WORKER_UNAVAILABLE" });
    expect(client.pendingCount).toBe(0);
  } finally { await client.close(); }
});
