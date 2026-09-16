/**
 * Structured Word generation and user-template filling.
 *
 * Adds three tools alongside the existing `word_create`/`word_append`/
 * `word_replace` (office-runtime.ts) without touching them: `word_compose`
 * (real headings/tables/lists/page-numbers via the `docx` library and one
 * of four built-in style profiles, or from Markdown), `word_template_inspect`
 * (read-only field discovery on a user-supplied `.docx` template), and
 * `word_template_fill` (fills a template's placeholders through
 * `docxtemplater`, when that optional dependency is installed).
 *
 * All three route through `runOfficeWrite`/`officeError` from
 * office-runtime.ts, so they get the exact same confirmation dialog, plan-mode
 * gate, workspace/attachment scope check, and no-overwrite atomic write as
 * every existing office tool — this file adds document generation, not a
 * second permission or file-writing path.
 */
import { readFile, stat, lstat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Packer } from "docx";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { stringParam, toolErrorMessage } from "./tool-params";
import {
  isOfficePathInScope,
  MAX_OFFICE_BYTES,
  officeError,
  runOfficeWrite,
  type OfficeRuntimeOptions,
  type OfficeWriteResult,
} from "./office-runtime";
import { validateDocumentSpec, type Block, type DocumentSpec, type Inline } from "./office/contracts";
import { BUILT_IN_STYLE_PROFILE_IDS, findStyleProfile, REPORT_ZH } from "./office/style-profiles";
import { generateDocxDocument } from "./office/docx-generate";
import { parseMarkdownToBlocks } from "./office/markdown";
import { parseInlineMarkdownText } from "./office/inline-text";
import { buildContentManifest, diffManifestAgainstDocx } from "./office/content-manifest";
import {
  checkTemplateEngineAvailability,
  fillTemplate,
  inspectTemplateFieldsOffline,
} from "./office/templates";

export const composeToolNames = ["word_compose", "word_template_inspect", "word_template_fill"] as const;
/** Only the two write actions need the plan-mode/mutation gate; inspecting a template's fields is read-only. */
export const composeMutatingToolNames = ["word_compose", "word_template_fill"] as const;

// ---------------------------------------------------------------------------
// word_compose
// ---------------------------------------------------------------------------

type RawInlineText = string;
interface RawHeadingBlock { readonly type: "heading"; readonly level: 1 | 2 | 3; readonly text: RawInlineText; }
interface RawParagraphBlock { readonly type: "paragraph"; readonly text: RawInlineText; readonly role?: "body" | "note"; }
interface RawListBlock { readonly type: "list"; readonly ordered?: boolean; readonly items: readonly RawInlineText[]; }
interface RawTableBlock {
  readonly type: "table";
  readonly columns: readonly { readonly title: RawInlineText; readonly widthWeight?: number }[];
  readonly rows: readonly (readonly RawInlineText[])[];
  readonly layout?: "auto" | "landscape";
}
interface RawPageBreakBlock { readonly type: "pageBreak"; }
type RawBlock = RawHeadingBlock | RawParagraphBlock | RawListBlock | RawTableBlock | RawPageBreakBlock;

function mapRawBlocksToContractBlocks(rawBlocks: readonly unknown[]): { readonly blocks: Block[]; readonly error?: string } {
  const blocks: Block[] = [];
  for (const [index, raw] of rawBlocks.entries()) {
    if (typeof raw !== "object" || raw === null || typeof (raw as Record<string, unknown>).type !== "string") {
      return { blocks: [], error: `blocks[${index}] 必须是带 type 字段的对象。` };
    }
    const block = raw as Record<string, unknown> & { type: string };
    const id = `block-${index}`;
    switch (block.type) {
      case "heading": {
        const level = block.level;
        if (level !== 1 && level !== 2 && level !== 3) return { blocks: [], error: `blocks[${index}].level 必须是 1、2 或 3。` };
        blocks.push({ id, type: "heading", level, content: parseInlineMarkdownText(String(block.text ?? "")) });
        break;
      }
      case "paragraph":
        blocks.push({
          id,
          type: "paragraph",
          content: parseInlineMarkdownText(String(block.text ?? "")),
          role: block.role === "note" ? "note" : "body",
        });
        break;
      case "list": {
        const items = block.items;
        if (!Array.isArray(items) || items.length === 0) return { blocks: [], error: `blocks[${index}].items 必须是非空数组。` };
        blocks.push({
          id,
          type: "list",
          ordered: Boolean(block.ordered),
          items: items.map((item) => parseInlineMarkdownText(String(item))),
        });
        break;
      }
      case "table": {
        const columns = block.columns;
        const rows = block.rows;
        if (!Array.isArray(columns) || columns.length === 0) return { blocks: [], error: `blocks[${index}].columns 必须是非空数组。` };
        if (!Array.isArray(rows)) return { blocks: [], error: `blocks[${index}].rows 必须是数组。` };
        const mappedColumns = columns.map((column, columnIndex) => {
          const c = column as { title?: unknown; widthWeight?: unknown };
          return { key: `col${columnIndex}`, title: String(c.title ?? ""), widthWeight: typeof c.widthWeight === "number" && c.widthWeight > 0 ? c.widthWeight : 1 };
        });
        for (const [rowIndex, row] of rows.entries()) {
          if (!Array.isArray(row) || row.length !== mappedColumns.length) {
            return { blocks: [], error: `blocks[${index}].rows[${rowIndex}] 的单元格数量必须等于列数（${mappedColumns.length}）。` };
          }
        }
        blocks.push({
          id,
          type: "table",
          columns: mappedColumns,
          rows: rows.map((row) => ({ cells: (row as readonly RawInlineText[]).map((cell) => ({ content: parseInlineMarkdownText(String(cell)) })) })),
          headerRows: 1,
          styleId: "default",
          layout: block.layout === "landscape" ? "landscape" : "auto",
        });
        break;
      }
      case "pageBreak":
        blocks.push({ id, type: "pageBreak" });
        break;
      case "image":
        return { blocks: [], error: `blocks[${index}]：word_compose 暂不支持 image 类型的 block（需要先登记授权资产，属于后续能力）。请改用 word_append 追加图片，或省略该块。` };
      default:
        return { blocks: [], error: `blocks[${index}].type 不支持：${block.type}` };
    }
  }
  return { blocks };
}

function headerFooterInline(value: string | undefined): Inline[] | undefined {
  if (!value) return undefined;
  return [{ type: "text", text: value }];
}

function createWordComposeTool(options: OfficeRuntimeOptions): ToolDefinition<any, OfficeWriteResult | { error: string }> {
  return {
    name: "word_compose",
    label: "Compose structured Word document",
    description:
      "Create a real Word document (headings, paragraphs, ordered/unordered lists, tables, page breaks, header/footer, page numbers) " +
      "from structured blocks or Markdown, using one of four built-in Chinese style profiles. Produces genuine styles/numbering, not a flat paragraph list.",
    promptSnippet: "word_compose: create a structured Word document (blocks or Markdown) using a built-in style profile.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        locale: { type: "string", enum: ["zh-CN", "en-US"] },
        styleProfileId: { type: "string", enum: [...BUILT_IN_STYLE_PROFILE_IDS] },
        inputFormat: { type: "string", enum: ["blocks", "markdown"] },
        markdown: { type: "string" },
        blocks: { type: "array", items: { type: "object" } },
        header: { type: "string" },
        footer: { type: "string" },
        pageNumbers: { type: "boolean" },
      },
      required: ["title", "inputFormat"],
    },
    async execute(_id, params, _signal, _update, ctx) {
      const title = stringParam(params, "title");
      const inputFormat = stringParam(params, "inputFormat");
      if (!title || (inputFormat !== "blocks" && inputFormat !== "markdown")) {
        return officeError("word_compose requires title and inputFormat ('blocks' or 'markdown').");
      }
      const rawParams = params as Record<string, unknown>;
      const styleProfileId = stringParam(params, "styleProfileId") ?? REPORT_ZH.id;
      const styleProfile = findStyleProfile(styleProfileId);
      if (!styleProfile) return officeError(`未知的 styleProfileId：${styleProfileId}`);
      const locale = stringParam(params, "locale") === "en-US" ? "en-US" : "zh-CN";

      let blocks: Block[];
      const warnings: string[] = [];
      if (inputFormat === "markdown") {
        const markdown = stringParam(params, "markdown");
        if (!markdown) return officeError("inputFormat 为 markdown 时必须提供 markdown 字段。");
        const parsed = parseMarkdownToBlocks(markdown);
        blocks = parsed.blocks as Block[];
        for (const downgrade of parsed.downgrades) warnings.push(`第 ${downgrade.line} 行（${downgrade.nodeType}）：${downgrade.message}`);
        if (blocks.length === 0) return officeError("Markdown 内容解析后没有任何受支持的段落/标题/列表/表格。");
      } else {
        const rawBlocks = Array.isArray(rawParams.blocks) ? (rawParams.blocks as unknown[]) : [];
        if (rawBlocks.length === 0) return officeError("inputFormat 为 blocks 时 blocks 不能为空。");
        const mapped = mapRawBlocksToContractBlocks(rawBlocks);
        if (mapped.error) return officeError(mapped.error);
        blocks = mapped.blocks;
      }

      const spec: DocumentSpec = {
        schemaVersion: 1,
        requestId: `word-compose-${randomUUID()}`,
        title,
        locale,
        styleProfileId: styleProfile.id,
        blocks,
        header: headerFooterInline(stringParam(params, "header")),
        footer: headerFooterInline(stringParam(params, "footer")),
        pageNumbers: typeof rawParams.pageNumbers === "boolean" ? rawParams.pageNumbers : undefined,
      };
      const validation = validateDocumentSpec(spec, { knownStyleProfileIds: BUILT_IN_STYLE_PROFILE_IDS });
      if (!validation.valid) {
        return officeError(`结构校验失败，未生成文件：\n${validation.errors.map((e) => `- ${e.path}: ${e.message}`).join("\n")}`);
      }

      return runOfficeWrite(options, ctx, "docx", undefined, async (outputPath) => {
        const { document } = generateDocxDocument({
          spec,
          styleProfile,
          resolveImage: () => { throw new Error("image blocks are not supported by word_compose."); },
        });
        const buffer = new Uint8Array(await Packer.toBuffer(document));

        // Defense-in-depth: this should never fail for a spec that just
        // passed validation and went straight through the generator, but if
        // it ever does, treat it as a generation bug rather than ship the
        // file — never claim untested content survived layout.
        const manifest = buildContentManifest(spec);
        const contentIssues = diffManifestAgainstDocx(manifest, buffer);
        if (contentIssues.length > 0) {
          throw new Error(
            `内容完整性自检失败，未保存文件：${contentIssues.map((issue) => issue.message).join("；")}`,
          );
        }

        const warningText = warnings.length > 0 ? `\n降级提示：\n${warnings.map((w) => `- ${w}`).join("\n")}` : "";
        return {
          buffer,
          changedItems: spec.blocks.length,
          summary: `新建 Word 文档《${title}》（样式：${styleProfile.displayName}，${spec.blocks.length} 个内容块）${warningText}`,
          outputPath,
        };
      });
    },
  };
}

// ---------------------------------------------------------------------------
// word_template_inspect (read-only)
// ---------------------------------------------------------------------------

function createWordTemplateInspectTool(options: OfficeRuntimeOptions): ToolDefinition<any, unknown> {
  return {
    name: "word_template_inspect",
    label: "Inspect Word template fields",
    description: "Read-only: list placeholder fields found in a user-supplied .docx template, and whether template filling is currently available.",
    promptSnippet: "word_template_inspect: list a .docx template's placeholder fields without modifying it.",
    parameters: { type: "object", properties: { sourcePath: { type: "string" } }, required: ["sourcePath"] },
    async execute(_id, params, _signal, _update, ctx) {
      try {
        options.assertAllowed?.();
        const sourcePath = stringParam(params, "sourcePath");
        if (!sourcePath) return officeError("word_template_inspect requires sourcePath.");
        const scope = options.getScope(ctx);
        if (!isOfficePathInScope(sourcePath, scope)) return officeError("源文件不在当前工作区或会话附件范围内。");
        if (path.extname(sourcePath).toLowerCase() !== ".docx") return officeError("模板文件扩展名必须是 .docx。");
        if ((await lstat(sourcePath)).isSymbolicLink()) return officeError("拒绝通过符号链接读取模板文件。");
        const info = await stat(sourcePath);
        if (!info.isFile() || info.size > MAX_OFFICE_BYTES) return officeError("模板文件不存在、不是普通文件或超过大小限制。");
        const buffer = new Uint8Array(await readFile(sourcePath));
        const [availability, inspection] = await Promise.all([
          checkTemplateEngineAvailability(),
          inspectTemplateFieldsOffline(buffer),
        ]);
        const details = { availability, inspection };
        const fieldList = inspection.fields.length > 0
          ? inspection.fields.map((field) => `${field.name}（${field.kind}）`).join("、")
          : "（未发现花括号占位符字段）";
        const availabilityLine = availability.available
          ? "模板填充功能可用。"
          : `模板填充当前不可用：${availability.reason}`;
        return { content: [{ type: "text", text: `字段：${fieldList}\n${availabilityLine}` }], details };
      } catch (error) {
        return officeError(toolErrorMessage(error));
      }
    },
  };
}

// ---------------------------------------------------------------------------
// word_template_fill
// ---------------------------------------------------------------------------

function createWordTemplateFillTool(options: OfficeRuntimeOptions): ToolDefinition<any, OfficeWriteResult | { error: string }> {
  return {
    name: "word_template_fill",
    label: "Fill Word template placeholders",
    description: "Fill a user-supplied .docx template's text/condition/loop placeholders with data and save an edited copy. Fails clearly if the template engine is unavailable or placeholders remain unfilled.",
    promptSnippet: "word_template_fill: fill a .docx template's placeholders with data.",
    parameters: {
      type: "object",
      properties: { sourcePath: { type: "string" }, data: { type: "object", additionalProperties: true } },
      required: ["sourcePath", "data"],
    },
    async execute(_id, params, _signal, _update, ctx) {
      const sourcePath = stringParam(params, "sourcePath");
      const rawParams = params as Record<string, unknown>;
      const data = typeof rawParams.data === "object" && rawParams.data !== null ? (rawParams.data as Record<string, unknown>) : undefined;
      if (!sourcePath || !data) return officeError("word_template_fill requires sourcePath and data.");
      return runOfficeWrite(options, ctx, "docx", sourcePath, async (outputPath, source) => {
        const result = await fillTemplate(source ?? new Uint8Array(), data);
        if (result.remainingPlaceholders.length > 0) {
          throw new Error(`模板填充后仍有未替换占位符：${result.remainingPlaceholders.join("、")}，请补充对应字段后重试，未保存文件。`);
        }
        return {
          buffer: result.buffer,
          changedItems: result.filledFields.length,
          summary: `填充模板占位符：${result.filledFields.join("、") || "（无字段）"}`,
          outputPath,
        };
      });
    },
  };
}

export function createOfficeComposeTools(options: OfficeRuntimeOptions): readonly ToolDefinition<any, any>[] {
  return [createWordComposeTool(options), createWordTemplateInspectTool(options), createWordTemplateFillTool(options)];
}

export function createOfficeComposeExtension(options: OfficeRuntimeOptions): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    for (const tool of createOfficeComposeTools(options)) pi.registerTool(tool);
  };
}
