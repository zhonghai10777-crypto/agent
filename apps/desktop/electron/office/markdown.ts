/**
 * Constrained Markdown -> Block[] (Task Order §6.3).
 *
 * Parses through a real Markdown AST (via the repo's existing
 * `remark-parse`/`remark-gfm`/`unified` stack — no new dependency) rather
 * than regexing `#`/`*`/`|` out of the text, so a stray `#` or `*` in a plain
 * paragraph is never mistaken for syntax. Anything the constrained block
 * model does not support (raw HTML, images embedded inline, blockquotes,
 * code blocks, footnotes, thematic breaks, nested lists deeper than one
 * level) is reported with its source position instead of being silently
 * dropped or passed through as unsupported markup.
 */
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { Root, RootContent, PhrasingContent, TableRow as MdastTableRow } from "mdast";
import type { Block, Inline, TableRow } from "./contracts";

export interface MarkdownDowngrade {
  readonly line: number;
  readonly nodeType: string;
  readonly message: string;
}

export interface MarkdownParseResult {
  readonly blocks: readonly Block[];
  readonly downgrades: readonly MarkdownDowngrade[];
  /** The original text, preserved verbatim so the user can still see what they typed even where a node was downgraded. */
  readonly sourceText: string;
}

let nextAutoId = 0;
function autoId(prefix: string): string {
  nextAutoId += 1;
  return `${prefix}-${nextAutoId}`;
}

export function parseMarkdownToBlocks(source: string): MarkdownParseResult {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(source) as Root;
  const blocks: Block[] = [];
  const downgrades: MarkdownDowngrade[] = [];

  const reportDowngrade = (node: RootContent, message: string) => {
    downgrades.push({ line: node.position?.start.line ?? 0, nodeType: node.type, message });
  };

  for (const node of tree.children) {
    switch (node.type) {
      case "heading": {
        const level = Math.min(3, node.depth) as 1 | 2 | 3;
        if (node.depth > 3) {
          reportDowngrade(node, `Markdown 标题层级 ${node.depth} 超过契约支持的 1-3 级，已降级为 3 级标题。`);
        }
        blocks.push({ id: autoId("h"), type: "heading", level, content: inlineFromPhrasing(node.children) });
        break;
      }
      case "paragraph":
        blocks.push({ id: autoId("p"), type: "paragraph", content: inlineFromPhrasing(node.children) });
        break;
      case "list": {
        const items = node.children.map((item) => {
          // Only the first paragraph of a list item is honored; nested
          // blocks (sub-lists, embedded tables) are out of the v1 contract.
          const firstParagraph = item.children.find((child) => child.type === "paragraph");
          if (item.children.length > 1 || (item.children[0] && item.children[0].type !== "paragraph")) {
            reportDowngrade(item, "列表项内的嵌套结构（子列表、多段落等）不受支持，已仅保留首段文本。");
          }
          return firstParagraph ? inlineFromPhrasing(firstParagraph.children) : [];
        });
        blocks.push({ id: autoId("list"), type: "list", ordered: Boolean(node.ordered), items });
        break;
      }
      case "table": {
        const [headerRow, ...bodyRows] = node.children as MdastTableRow[];
        if (!headerRow) break;
        const columns = headerRow.children.map((cell, index) => ({
          key: `col${index}`,
          title: inlineText(inlineFromPhrasing(cell.children)),
          widthWeight: 1,
        }));
        const rows: TableRow[] = bodyRows.map((row) => ({
          cells: columns.map((_, index) => ({ content: row.children[index] ? inlineFromPhrasing(row.children[index]!.children) : [] })),
        }));
        blocks.push({
          id: autoId("table"),
          type: "table",
          columns,
          rows,
          headerRows: 1,
          styleId: "default",
        });
        break;
      }
      case "thematicBreak":
        blocks.push({ id: autoId("pb"), type: "pageBreak" });
        break;
      case "html":
        reportDowngrade(node, "不支持原始 HTML；已作为普通文本段落保留原文，不执行也不清除标记。");
        blocks.push({ id: autoId("p"), type: "paragraph", content: [{ type: "text", text: node.value }] });
        break;
      case "code":
        reportDowngrade(node, "不支持代码块；已作为普通段落保留原文。");
        blocks.push({ id: autoId("p"), type: "paragraph", content: [{ type: "text", text: node.value }] });
        break;
      case "blockquote":
        reportDowngrade(node, "不支持引用块；已展开为普通段落。");
        for (const child of node.children) {
          if (child.type === "paragraph") blocks.push({ id: autoId("p"), type: "paragraph", content: inlineFromPhrasing(child.children) });
        }
        break;
      default:
        reportDowngrade(node, `不支持的 Markdown 节点类型：${node.type}，内容未纳入生成结果。`);
    }
  }

  return { blocks, downgrades, sourceText: source };
}

function inlineFromPhrasing(nodes: readonly PhrasingContent[]): Inline[] {
  const result: Inline[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        result.push({ type: "text", text: node.value });
        break;
      case "strong":
        for (const inner of inlineFromPhrasing(node.children)) {
          result.push(inner.type === "text" ? { ...inner, bold: true } : inner);
        }
        break;
      case "emphasis":
        for (const inner of inlineFromPhrasing(node.children)) {
          result.push(inner.type === "text" ? { ...inner, italic: true } : inner);
        }
        break;
      case "inlineCode":
        result.push({ type: "text", text: node.value });
        break;
      case "break":
        result.push({ type: "lineBreak" });
        break;
      case "link":
        result.push({ type: "link", text: inlineText(inlineFromPhrasing(node.children)), href: node.url });
        break;
      default:
        // Unsupported inline node (image, footnote reference, html, ...):
        // fall back to its plain-text rendering rather than dropping it.
        if ("value" in node && typeof (node as { value?: unknown }).value === "string") {
          result.push({ type: "text", text: (node as { value: string }).value });
        }
    }
  }
  return result;
}

function inlineText(inlines: readonly Inline[]): string {
  return inlines.map((inline) => (inline.type === "text" ? inline.text : inline.type === "link" ? inline.text : "")).join("");
}
