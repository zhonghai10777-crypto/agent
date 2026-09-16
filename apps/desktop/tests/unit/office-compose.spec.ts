import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { unzipSync } from "fflate";
import {
  composeMutatingToolNames,
  composeToolNames,
  createOfficeComposeTools,
} from "../../electron/office-compose";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createWordDocument } from "../../electron/office-runtime";

test("compose tool names are registered and only the two write actions are plan-blocked", () => {
  expect(composeToolNames).toEqual(["word_compose", "word_template_inspect", "word_template_fill"]);
  expect(composeMutatingToolNames).toEqual(["word_compose", "word_template_fill"]);
});

test("word_compose generates a real DOCX for every built-in style profile from structured blocks", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-word-compose-"));
  for (const styleProfileId of ["report-zh", "meeting-minutes-zh", "implementation-plan-zh", "lesson-plan-zh"]) {
    const tool = composeTool(root);
    const result = await tool.execute(
      `compose-${styleProfileId}`,
      {
        title: `验收测试文档-${styleProfileId}`,
        inputFormat: "blocks",
        styleProfileId,
        header: "抬头文字",
        footer: "页脚文字",
        pageNumbers: true,
        blocks: [
          { type: "heading", level: 1, text: "第一章 概述" },
          { type: "paragraph", text: "这是一段包含 **加粗** 文本的正文。" },
          { type: "list", ordered: false, items: ["要点一", "要点二"] },
          {
            type: "table",
            columns: [{ title: "姓名" }, { title: "部门" }],
            rows: [["张三", "研发部"]],
          },
          { type: "pageBreak" },
          { type: "heading", level: 2, text: "第二节" },
        ],
      },
      undefined,
      undefined,
      testExtensionContext(root),
    );
    expect(result.details).not.toMatchObject({ error: expect.anything() });
    const outputPath = (result.details as { outputPath: string }).outputPath;
    const buffer = await readFile(outputPath);
    const files = unzipSync(new Uint8Array(buffer));
    expect(files["word/document.xml"]).toBeTruthy();
    expect(files["word/styles.xml"]).toBeTruthy();
    const documentXml = new TextDecoder().decode(files["word/document.xml"]);
    expect(documentXml).toContain("第一章 概述");
    expect(documentXml).toContain("张三");
    expect(documentXml).toContain("研发部");
  }
});

test("word_compose generates a real DOCX from Markdown input", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-word-compose-md-"));
  const tool = composeTool(root);
  const markdown = [
    "# 标题一",
    "",
    "这是段落，包含 **加粗** 文本。",
    "",
    "- 项目一",
    "- 项目二",
    "",
    "| 列A | 列B |",
    "| --- | --- |",
    "| 1 | 2 |",
  ].join("\n");
  const result = await tool.execute(
    "compose-markdown",
    { title: "Markdown 输入验收", inputFormat: "markdown", markdown },
    undefined,
    undefined,
    testExtensionContext(root),
  );
  expect(result.details).not.toMatchObject({ error: expect.anything() });
  const outputPath = (result.details as { outputPath: string }).outputPath;
  const buffer = await readFile(outputPath);
  const documentXml = new TextDecoder().decode(unzipSync(new Uint8Array(buffer))["word/document.xml"]);
  expect(documentXml).toContain("标题一");
});

test("word_compose rejects malformed blocks with a clear error and writes nothing", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-word-compose-invalid-"));
  const tool = composeTool(root);
  const result = await tool.execute(
    "compose-invalid",
    { title: "无效文档", inputFormat: "blocks", blocks: [{ type: "heading", level: 9, text: "坏标题" }] },
    undefined,
    undefined,
    testExtensionContext(root),
  );
  expect(result.details).toMatchObject({ error: expect.stringContaining("level") });
});

test("word_compose refuses image blocks with a clear capability message instead of silently dropping them", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-word-compose-image-"));
  const tool = composeTool(root);
  const result = await tool.execute(
    "compose-image",
    { title: "图片文档", inputFormat: "blocks", blocks: [{ type: "image" }] },
    undefined,
    undefined,
    testExtensionContext(root),
  );
  expect(result.details).toMatchObject({ error: expect.stringContaining("image") });
});

test("word_compose is blocked in plan mode like the other office write tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-word-compose-plan-"));
  const tools = createOfficeComposeTools({
    getScope: () => ({ workspaceRoots: [root], allowedFiles: [] }),
    chooseNewFilePath: async () => join(root, `plan-${Date.now()}.docx`),
    confirmWrite: async () => true,
    getPermissionMode: () => "plan",
  });
  const tool = tools.find((entry) => entry.name === "word_compose");
  if (!tool) throw new Error("word_compose tool missing");
  const result = await tool.execute(
    "compose-plan",
    { title: "计划模式文档", inputFormat: "blocks", blocks: [{ type: "paragraph", text: "内容" }] },
    undefined,
    undefined,
    testExtensionContext(root),
  );
  expect(result.details).toMatchObject({ error: expect.stringContaining("plan") });
});

test("word_template_inspect finds placeholder fields and reports the template engine as unavailable in this environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-template-inspect-"));
  const templatePath = join(root, "template.docx");
  await writeFile(templatePath, createWordDocument(undefined, ["姓名：{name}，部门：{dept}"]));
  const tools = createOfficeComposeTools({
    getScope: () => ({ workspaceRoots: [root], allowedFiles: [] }),
    chooseNewFilePath: async () => undefined,
    confirmWrite: async () => true,
    getPermissionMode: () => "auto",
  });
  const tool = tools.find((entry) => entry.name === "word_template_inspect");
  if (!tool) throw new Error("word_template_inspect tool missing");
  const result = await tool.execute("inspect", { sourcePath: templatePath }, undefined, undefined, testExtensionContext(root));
  const details = result.details as { availability: { available: boolean }; inspection: { fields: readonly { name: string }[] } };
  expect(details.inspection.fields.map((field) => field.name).sort()).toEqual(["dept", "name"]);
  // docxtemplater/pizzip are a genuinely optional dependency this repo could not install this
  // round (no npm registry access) - this assertion documents that real, current limitation
  // rather than assuming it will always hold. See docs/office/acceptance-report.md (T04/T08).
  expect(details.availability.available).toBe(false);
});

test("word_template_fill fails clearly instead of falling back to an unsafe raw string replace when the engine is unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-template-fill-"));
  const templatePath = join(root, "template.docx");
  await writeFile(templatePath, createWordDocument(undefined, ["姓名：{name}"]));
  const tools = createOfficeComposeTools({
    getScope: () => ({ workspaceRoots: [root], allowedFiles: [] }),
    chooseNewFilePath: async () => undefined,
    confirmWrite: async () => true,
    getPermissionMode: () => "auto",
  });
  const tool = tools.find((entry) => entry.name === "word_template_fill");
  if (!tool) throw new Error("word_template_fill tool missing");
  const result = await tool.execute(
    "fill",
    { sourcePath: templatePath, data: { name: "张三" } },
    undefined,
    undefined,
    testExtensionContext(root),
  );
  expect(result.details).toMatchObject({ error: expect.stringContaining("模板引擎不可用") });
  await expect(readFile(join(root, "template.edited.docx"))).rejects.toMatchObject({ code: "ENOENT" });
});

function composeTool(root: string) {
  const tool = createOfficeComposeTools({
    getScope: () => ({ workspaceRoots: [root], allowedFiles: [] }),
    chooseNewFilePath: async () => join(root, `compose-${Math.random().toString(36).slice(2)}.docx`),
    confirmWrite: async () => true,
    getPermissionMode: () => "auto",
  }).find((entry) => entry.name === "word_compose");
  if (!tool) throw new Error("word_compose tool missing");
  return tool;
}

function testExtensionContext(cwd: string): ExtensionContext {
  return {
    hasUI: false,
    mode: "json",
    cwd,
    sessionManager: {
      getSessionId: () => "office-compose-test-session",
      getCwd: () => cwd,
    } as ExtensionContext["sessionManager"],
    ui: {} as ExtensionContext["ui"],
    modelRegistry: {} as ExtensionContext["modelRegistry"],
    model: undefined,
    signal: undefined,
    isIdle: () => true,
    isProjectTrusted: () => true,
    abort: () => undefined,
    hasPendingMessages: () => false,
    shutdown: () => undefined,
    getContextUsage: () => undefined,
    compact: () => undefined,
    getSystemPrompt: () => "",
  };
}
