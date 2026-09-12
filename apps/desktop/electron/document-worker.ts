import { parentPort } from "node:worker_threads";
import { extractDocument } from "./document-extract";
import { readDocumentBytes } from "./document-file";

if (!parentPort) {
  throw new Error("Document worker requires a parent port.");
}

parentPort.on("message", async (message: { readonly id: number; readonly buffer?: ArrayBuffer; readonly filePath: string; readonly key: string }) => {
  try {
    const bytes = message.buffer ? new Uint8Array(message.buffer) : await readDocumentBytes(message.filePath, message.key);
    const result = await extractDocument(bytes, message.filePath);
    parentPort?.postMessage({ id: message.id, result });
  } catch (error) {
    parentPort?.postMessage({
      id: message.id,
      result: {
        ok: false, kind: "unknown",
        reason: (error as NodeJS.ErrnoException).code === "DOCUMENT_CHANGED" ? "changed" :
          (error as NodeJS.ErrnoException).code === "DOCUMENT_TOO_LARGE" ? "too-large" : "unavailable",
        code: ["DOCUMENT_CHANGED", "DOCUMENT_TOO_LARGE"].includes((error as NodeJS.ErrnoException).code ?? "")
          ? (error as NodeJS.ErrnoException).code : "DOCUMENT_UNREADABLE",
        detail: error instanceof Error ? error.message : String(error),
      },
    });
  }
});
