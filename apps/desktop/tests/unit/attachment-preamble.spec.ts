import path from "node:path";
import { expect, test } from "@playwright/test";
import type { SessionAttachment } from "@pi-gui/session-driver";
import {
  injectFileAttachmentPreamble,
  transcriptFromMessages,
} from "../../../../packages/pi-sdk-driver/src/session-supervisor-utils";

const pdf = (overrides: Partial<Extract<SessionAttachment, { kind: "file" }>> = {}): SessionAttachment => ({
  kind: "file",
  name: "规程.pdf",
  mimeType: "application/pdf",
  fsPath: path.join("/tmp", "规程.pdf"),
  ...overrides,
});

function payloadOf(prompt: string): Record<string, any> {
  const start = prompt.indexOf("<pi-gui-file-attachments>") + "<pi-gui-file-attachments>".length;
  const end = prompt.indexOf("</pi-gui-file-attachments>");
  return JSON.parse(prompt.slice(start, end));
}

test("inlines a short document and says so", () => {
  const prompt = injectFileAttachmentPreamble("第 3.2 条怎么说？", [
    pdf({ extraction: { status: "ok", pages: 2, chars: 40 }, documentText: "第 3.2 条：效率不低于 92%。" }),
  ]);

  const payload = payloadOf(prompt);
  expect(payload.files[0].text).toBe("第 3.2 条：效率不低于 92%。");
  expect(payload.instructions.join(" ")).toContain("full text");
  expect(prompt.endsWith("第 3.2 条怎么说？")).toBe(true);
});

test("points a long document at read_document and warns off the read tool", () => {
  const prompt = injectFileAttachmentPreamble("总结一下", [
    pdf({ extraction: { status: "ok", pages: 312, chars: 900_000 } }),
  ]);

  const payload = payloadOf(prompt);
  expect(payload.files[0].text).toBeUndefined();
  const instructions = payload.instructions.join(" ");
  expect(instructions).toContain("read_document");
  expect(instructions).toContain("312 page(s)");
  // Without this the model falls back to pi's read tool, which returns mojibake
  // for a PDF and produces a confident wrong answer.
  expect(instructions).toContain("Do NOT use read");
});

test("tells the model a scan could not be read instead of letting it guess", () => {
  const prompt = injectFileAttachmentPreamble("这页写了什么？", [
    pdf({ extraction: { status: "failed", reason: "scanned-pdf" } }),
  ]);

  const instructions = payloadOf(prompt).instructions.join(" ");
  expect(instructions).toContain("scanned-pdf");
  expect(instructions).toContain("Do NOT call read");
});

test("a safety-limited document is explicitly partial in model guidance", () => {
  const prompt = injectFileAttachmentPreamble("Find the tail", [pdf({ extraction: { status: "ok", chars: 4_000_000, complete: false, charLimit: 4_000_000 } })]);
  expect(payloadOf(prompt).instructions.join(" ")).toContain("Only part of this document is available");
});

test("strips the whole block back out of the transcript", () => {
  const prompt = injectFileAttachmentPreamble("第 3.2 条怎么说？", [
    pdf({ extraction: { status: "ok", pages: 2, chars: 40 }, documentText: "第 3.2 条：效率不低于 92%。" }),
  ]);

  const [message] = transcriptFromMessages([{ role: "user", content: prompt }]);

  // Guidance and inlined text live inside the delimiters precisely so none of
  // it leaks into what the user sees as their own message.
  expect(message?.text).toBe("第 3.2 条怎么说？");
  expect(message?.text).not.toContain("read_document");
  expect(message?.text).not.toContain("pi-gui-file-attachments");
  expect(message?.attachments?.[0]?.name).toBe("规程.pdf");
});

test("leaves a prompt without file attachments untouched", () => {
  expect(injectFileAttachmentPreamble("你好", [])).toBe("你好");
  expect(injectFileAttachmentPreamble("你好", undefined)).toBe("你好");
  expect(injectFileAttachmentPreamble("你好", [{ kind: "image", mimeType: "image/png", data: "x" }])).toBe("你好");
});
