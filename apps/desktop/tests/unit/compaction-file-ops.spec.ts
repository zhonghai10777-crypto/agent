import { expect, test } from "@playwright/test";
import { collectDesktopFileOps } from "../../electron/compaction-file-ops";

/** An assistant message with a single tool call, matching pi's AgentMessage shape. */
function assistantToolCall(name: string, args: Record<string, unknown>) {
  return {
    role: "assistant" as const,
    content: [{ type: "toolCall", id: `${name}-call`, name, arguments: args }],
  };
}

/** A toolResult message, matching pi's AgentMessage shape (isError defaults to false, as runOfficeWrite always returns). */
function toolResult(toolName: string, details: unknown, isError = false) {
  return { role: "toolResult" as const, toolCallId: `${toolName}-call`, toolName, details, isError, content: [] };
}

test("S3.1: read_document reads and a successful word_replace's source + output are both tracked", () => {
  const messages = [
    assistantToolCall("read_document", { path: "/ws/report.pdf" }),
    assistantToolCall("word_replace", { sourcePath: "/ws/doc.docx", search: "a", replacement: "b" }),
    toolResult("word_replace", {
      format: "docx", sourcePath: "/ws/doc.docx", outputPath: "/ws/doc.edited.docx", summary: "replaced", changedItems: 1,
    }),
  ];
  const ops = collectDesktopFileOps(messages);
  expect(ops.read).toEqual(["/ws/doc.docx", "/ws/report.pdf"]);
  expect(ops.written).toEqual(["/ws/doc.edited.docx"]);
});

test("word_create and word_compose have no sourcePath to read, only a written output", () => {
  const messages = [
    assistantToolCall("word_create", { title: "New doc" }),
    toolResult("word_create", { format: "docx", outputPath: "/ws/new.docx", summary: "created", changedItems: 1 }),
    assistantToolCall("word_compose", { title: "Report", inputFormat: "markdown", markdown: "# Report" }),
    toolResult("word_compose", { format: "docx", outputPath: "/ws/report.docx", summary: "composed", changedItems: 3 }),
  ];
  const ops = collectDesktopFileOps(messages);
  expect(ops.read).toEqual([]);
  expect(ops.written).toEqual(["/ws/new.docx", "/ws/report.docx"]);
});

test("word_template_inspect is read-only: its sourcePath is tracked as a read, never as a write", () => {
  const messages = [
    assistantToolCall("word_template_inspect", { sourcePath: "/ws/template.docx" }),
    // Even if a future bug made this tool return an outputPath-shaped payload,
    // it must never count as a write: it is not in WRITE_TOOLS.
    toolResult("word_template_inspect", { availability: { available: true }, inspection: { fields: [] } }),
  ];
  const ops = collectDesktopFileOps(messages);
  expect(ops.read).toEqual(["/ws/template.docx"]);
  expect(ops.written).toEqual([]);
});

test("word_template_fill and excel_update_cells both read their source and write their output", () => {
  const messages = [
    assistantToolCall("word_template_fill", { sourcePath: "/ws/tpl.docx", data: { name: "A" } }),
    toolResult("word_template_fill", { format: "docx", sourcePath: "/ws/tpl.docx", outputPath: "/ws/tpl.edited.docx", summary: "filled", changedItems: 1 }),
    assistantToolCall("excel_update_cells", { sourcePath: "/ws/book.xlsx", sheet: "Sheet1", cells: { A1: 1 } }),
    toolResult("excel_update_cells", { format: "xlsx", sourcePath: "/ws/book.xlsx", outputPath: "/ws/book.edited.xlsx", summary: "updated", changedItems: 1 }),
  ];
  const ops = collectDesktopFileOps(messages);
  expect(ops.read).toEqual(["/ws/book.xlsx", "/ws/tpl.docx"]);
  expect(ops.written).toEqual(["/ws/book.edited.xlsx", "/ws/tpl.edited.docx"]);
});

test("S3.2: a failed write (details = { error }, no outputPath) is never counted as modified, regardless of isError", () => {
  const messages = [
    assistantToolCall("word_replace", { sourcePath: "/ws/doc.docx", search: "missing", replacement: "x" }),
    // This is exactly the shape runOfficeWrite's catch path returns: a normal
    // (non-thrown) result with isError left at its default false.
    toolResult("word_replace", { error: "未在文档中找到文本，未保存文件。" }, false),
  ];
  const ops = collectDesktopFileOps(messages);
  expect(ops.read).toEqual(["/ws/doc.docx"]);
  expect(ops.written).toEqual([]);

  const withIsErrorTrue = [
    assistantToolCall("excel_add_sheet", { sourcePath: "/ws/book.xlsx", sheet: "New" }),
    toolResult("excel_add_sheet", { error: "Worksheet already exists: New" }, true),
  ];
  expect(collectDesktopFileOps(withIsErrorTrue).written).toEqual([]);
});

test("non-desktop tool calls (e.g. bash, read) are ignored entirely", () => {
  const messages = [
    assistantToolCall("bash", { command: "ls" }),
    toolResult("bash", { stdout: "a.txt", stderr: "", exitCode: 0 }),
    assistantToolCall("read", { path: "/ws/notes.txt" }),
    toolResult("read", { content: "hello" }),
  ];
  const ops = collectDesktopFileOps(messages);
  expect(ops.read).toEqual([]);
  expect(ops.written).toEqual([]);
});

test("duplicate paths across multiple calls are deduplicated and results are sorted", () => {
  const messages = [
    assistantToolCall("read_document", { path: "/ws/b.pdf" }),
    assistantToolCall("read_document", { path: "/ws/a.pdf" }),
    assistantToolCall("read_document", { path: "/ws/b.pdf" }),
    assistantToolCall("excel_create", { sheetName: "S1" }),
    toolResult("excel_create", { format: "xlsx", outputPath: "/ws/z.xlsx", summary: "created", changedItems: 0 }),
    assistantToolCall("excel_create", { sheetName: "S2" }),
    toolResult("excel_create", { format: "xlsx", outputPath: "/ws/z.xlsx", summary: "created", changedItems: 0 }),
  ];
  const ops = collectDesktopFileOps(messages);
  expect(ops.read).toEqual(["/ws/a.pdf", "/ws/b.pdf"]);
  expect(ops.written).toEqual(["/ws/z.xlsx"]);
});

test("malformed or missing shapes are skipped without throwing", () => {
  const messages: unknown[] = [
    null,
    undefined,
    42,
    { role: "assistant" }, // no content
    { role: "assistant", content: "not-an-array" },
    { role: "assistant", content: [null, 42, { type: "toolCall" }, { type: "toolCall", name: "word_replace" }] }, // no arguments
    { role: "assistant", content: [{ type: "toolCall", name: "word_replace", arguments: { sourcePath: 123 } }] }, // non-string path
    { role: "toolResult" }, // no toolName/details
    { role: "toolResult", toolName: "word_replace" }, // no details
    { role: "toolResult", toolName: "word_replace", details: "not-an-object" },
    { role: "toolResult", toolName: "word_replace", details: { outputPath: 123 } }, // non-string outputPath
    { role: "unknown-role", content: [] },
  ];
  expect(() => collectDesktopFileOps(messages)).not.toThrow();
  const ops = collectDesktopFileOps(messages);
  expect(ops.read).toEqual([]);
  expect(ops.written).toEqual([]);
});
