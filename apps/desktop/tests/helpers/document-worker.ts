import path from "node:path";
import { DocumentWorkerClient } from "../../electron/document-worker-client";

/** Unit tests use the real build output explicitly. Production resolves beside
 * its running main bundle, independent of the app's launch working directory. */
export function builtDocumentWorker(): DocumentWorkerClient {
  return new DocumentWorkerClient({ workerPath: path.resolve(__dirname, "../../out/main/document-worker.mjs") });
}
