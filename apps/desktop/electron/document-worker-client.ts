import { Worker } from "node:worker_threads";
import path from "node:path";
import type { DocumentExtraction, DocumentExtractionFailure } from "./document-extract";
import { MAX_DOCUMENT_PARSE_MS, MAX_DOCUMENT_QUEUE } from "./document-limits";

interface Subscriber {
  finish(result: DocumentExtraction): void;
}
interface Job {
  readonly id: number;
  readonly key: string;
  readonly filePath: string;
  readonly readBuffer?: () => Promise<Uint8Array>;
  readonly subscribers: Set<Subscriber>;
}
export interface DocumentWorkerOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Injectable I/O for failure tests; production reads inside the Worker. */
  readonly readBuffer?: () => Promise<Uint8Array>;
}

export class DocumentWorkerClient {
  private worker?: Worker;
  private stopping?: Promise<unknown>;
  private active?: Job;
  private readonly jobs = new Map<string, Job>();
  private nextId = 0;
  private closed = false;

  constructor(private readonly options: {
    readonly workerPath?: string;
    readonly maxQueue?: number;
    readonly timeoutMs?: number;
  } = {}) {}

  get pendingCount(): number { return this.jobs.size; }

  run(filePath: string, key: string, options: DocumentWorkerOptions = {}): Promise<DocumentExtraction> {
    if (options.signal?.aborted) return Promise.resolve(cancelled());
    if (this.closed) return Promise.resolve(unavailable("Document worker has been closed."));
    let job = this.jobs.get(key);
    if (!job) {
      if (this.jobs.size >= (this.options.maxQueue ?? MAX_DOCUMENT_QUEUE)) {
        return Promise.resolve(failure("queue-full", "DOCUMENT_QUEUE_FULL", "The document queue is full. Retry after current work completes."));
      }
      job = { id: ++this.nextId, key, filePath, readBuffer: options.readBuffer, subscribers: new Set() };
      this.jobs.set(key, job);
    }
    const shared = job;
    return new Promise((resolve) => {
      let finished = false;
      const subscriber: Subscriber = { finish: (result) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        shared.subscribers.delete(subscriber);
        resolve(result);
        if (!shared.subscribers.size && this.jobs.get(key) === shared) {
          this.jobs.delete(key);
          if (this.active === shared) { this.active = undefined; void this.stopWorker(); }
        }
      } };
      const abort = () => subscriber.finish(cancelled());
      const timer = setTimeout(() => subscriber.finish(failure("timeout", "DOCUMENT_PARSE_TIMEOUT", "Document parsing timed out. Retry or use a smaller document.")),
        Math.max(1, options.timeoutMs ?? this.options.timeoutMs ??
          (process.env.PI_APP_TEST_MODE ? Number(process.env.PI_APP_TEST_DOCUMENT_PARSE_MS) || MAX_DOCUMENT_PARSE_MS : MAX_DOCUMENT_PARSE_MS)));
      shared.subscribers.add(subscriber);
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
      void this.pump();
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const job of [...this.jobs.values()]) this.finish(job, cancelled());
    await this.stopWorker();
  }

  private async pump(): Promise<void> {
    if (this.closed || this.active || this.stopping) return;
    const job = this.jobs.values().next().value as Job | undefined;
    if (!job) { this.worker?.unref(); return; }
    this.active = job;
    try {
      const worker = this.worker ?? this.startWorker();
      worker.ref();
      const bytes = await job.readBuffer?.();
      if (this.active !== job || this.worker !== worker) return;
      // Only test-injected buffers cross threads; production opens the path in
      // the Worker after the job reaches the head of the queue.
      const buffer = bytes ? Uint8Array.from(bytes).buffer : undefined;
      worker.postMessage({ id: job.id, filePath: job.filePath, key: job.key, buffer }, buffer ? [buffer] : []);
    } catch (error) {
      if (this.active === job) {
        this.finish(job, job.readBuffer ? failure("unavailable", "DOCUMENT_UNREADABLE", message(error)) : unavailable(message(error)));
        await this.stopWorker();
      }
    }
  }

  private startWorker(): Worker {
    // electron-vite supplies bundle-relative __dirname; never depends on cwd.
    const worker = new Worker(this.options.workerPath ??
      (process.env.PI_APP_TEST_MODE ? process.env.PI_APP_TEST_DOCUMENT_WORKER_PATH : undefined) ??
      path.join(__dirname, "document-worker.mjs"), {
      resourceLimits: { maxOldGenerationSizeMb: 192, stackSizeMb: 4 },
    });
    this.worker = worker;
    worker.on("message", (response: { id: number; result?: DocumentExtraction; error?: string }) => {
      if (this.worker !== worker || this.active?.id !== response.id) return;
      this.finish(this.active, response.result ?? unavailable(response.error ?? "Document worker returned no result."));
      void this.pump();
    });
    const stopped = (detail: string) => {
      if (this.worker !== worker) return;
      if (this.active) this.finish(this.active, unavailable(detail));
      void this.stopWorker();
    };
    worker.on("error", (error) => stopped(message(error)));
    worker.on("exit", (code) => stopped(`Document worker exited with code ${code} before completing.`));
    return worker;
  }

  private finish(job: Job, result: DocumentExtraction): void {
    if (this.jobs.get(job.key) !== job) return;
    this.jobs.delete(job.key);
    if (this.active === job) this.active = undefined;
    for (const subscriber of [...job.subscribers]) subscriber.finish(result);
  }

  private async stopWorker(): Promise<void> {
    if (this.stopping) { await this.stopping; return; }
    const worker = this.worker;
    this.worker = undefined;
    if (worker) {
      worker.removeAllListeners();
      // Keep one error listener during termination to avoid an unhandled error.
      worker.on("error", () => {});
      this.stopping = worker.terminate();
      try { await this.stopping; } finally { this.stopping = undefined; worker.removeAllListeners(); }
    }
    void this.pump();
  }
}

function failure(reason: DocumentExtractionFailure["reason"], code: string, detail: string): DocumentExtractionFailure {
  return { ok: false, kind: "unknown", reason, code, detail };
}
function unavailable(detail: string): DocumentExtractionFailure { return failure("worker-unavailable", "DOCUMENT_WORKER_UNAVAILABLE", detail); }
function cancelled(): DocumentExtractionFailure { return failure("cancelled", "DOCUMENT_CANCELLED", "Document reading was cancelled."); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
