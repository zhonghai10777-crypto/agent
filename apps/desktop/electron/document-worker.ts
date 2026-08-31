import { parentPort } from "node:worker_threads";
import { extractDocument } from "./document-extract";

if (!parentPort) {
  throw new Error("Document worker requires a parent port.");
}

parentPort.on("message", async (message: { readonly id: number; readonly buffer: ArrayBuffer; readonly fileName: string }) => {
  try {
    const result = await extractDocument(new Uint8Array(message.buffer), message.fileName);
    parentPort?.postMessage({ id: message.id, result });
  } catch (error) {
    parentPort?.postMessage({
      id: message.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
