import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { builtDocumentWorker } from "../helpers/document-worker";

const worker = builtDocumentWorker();
test.afterAll(() => worker.close());
import {
  FAILURE_TTL_MS,
  getDocumentExtraction,
  getDocumentParts,
  invalidateDocumentCache,
} from "../../electron/document-cache";

test.afterEach(() => invalidateDocumentCache());

test("a transient read failure recovers with identical file metadata", async ({}, testInfo) => {
  await mkdir(testInfo.outputDir, { recursive: true });
  const file = testInfo.outputPath("规程.txt");
  await writeFile(file, "恢复后可以读取的规程");
  const metadata = await stat(file);
  let reads = 0;
  const options = { worker, io: {
    stat: async () => metadata,
    readFile: async () => {
      if (++reads === 1) throw Object.assign(new Error("temporary lock"), { code: "EACCES" });
      return new Uint8Array(await readFile(file));
    },
  } };
  expect((await getDocumentExtraction(file, options)).ok).toBe(false);
  expect(await getDocumentParts(file, options)).toMatchObject({ unit: "section", parts: ["恢复后可以读取的规程"] });
  expect(reads).toBe(2);
  expect((await stat(file)).mtimeMs).toBe(metadata.mtimeMs);
  expect((await getDocumentExtraction(file, options)).ok).toBe(true);
  expect(reads).toBe(2);
});

test("parse failures expire and explicit reattachment retries before expiry", async ({}, testInfo) => {
  await mkdir(testInfo.outputDir, { recursive: true });
  const file = testInfo.outputPath("broken.docx");
  await writeFile(file, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("word/document.xml broken ZIP")]));
  let reads = 0;
  let time = 100;
  const options = {
    worker,
    now: () => time,
    io: { stat, readFile: async (path: string) => { reads += 1; return new Uint8Array(await readFile(path)); } },
  };
  expect((await getDocumentExtraction(file, options)).ok).toBe(false);
  await getDocumentExtraction(file, options);
  expect(reads).toBe(1);
  await getDocumentExtraction(file, { ...options, retryFailures: true });
  expect(reads).toBe(2);
  time += FAILURE_TTL_MS;
  await getDocumentExtraction(file, options);
  expect(reads).toBe(3);
});

test("reattachment preserves the successful extraction cache", async ({}, testInfo) => {
  await mkdir(testInfo.outputDir, { recursive: true });
  const file = testInfo.outputPath("valid.txt");
  await writeFile(file, "already extracted");
  let reads = 0;
  const options = { worker, io: { stat, readFile: async (path: string) => {
    reads += 1;
    return new Uint8Array(await readFile(path));
  } } };
  expect((await getDocumentExtraction(file, options)).ok).toBe(true);
  expect((await getDocumentExtraction(file, { ...options, retryFailures: true })).ok).toBe(true);
  expect(reads).toBe(1);
});
