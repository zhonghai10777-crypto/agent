/**
 * Content-integrity manifest (Task Order §6.2).
 *
 * Built directly from the accepted `DocumentSpec`, before generation. After
 * the DOCX is produced (and again after any auto-fix revision), the
 * generated file is re-extracted and diffed against this manifest. This can
 * only prove "nothing the model asked for went missing or was rewritten
 * during layout" — it says nothing about whether the original request was
 * captured faithfully in the first place (a separate, spec-level
 * requirements checklist is out of this file's scope; see §6.2's own
 * caveat).
 */
import { unzipSync } from "fflate";
import type { Block, DocumentSpec, Inline } from "./contracts";

export interface ManifestBlockSummary {
  readonly blockId: string;
  readonly type: Block["type"];
  /** Concatenated visible text for text-bearing blocks (heading/paragraph/list items joined, table cells joined). */
  readonly text: string;
  readonly tableRows?: number;
  readonly tableColumns?: number;
  readonly imageAssetId?: string;
}

export interface ContentManifest {
  readonly requestId: string;
  readonly title: string;
  readonly blocks: readonly ManifestBlockSummary[];
}

function inlineText(content: readonly Inline[]): string {
  return content
    .map((inline) => (inline.type === "text" ? inline.text : inline.type === "link" ? inline.text : ""))
    .join("");
}

export function buildContentManifest(spec: DocumentSpec): ContentManifest {
  const blocks: ManifestBlockSummary[] = [];
  for (const block of spec.blocks) {
    switch (block.type) {
      case "heading":
      case "paragraph":
        blocks.push({ blockId: block.id, type: block.type, text: inlineText(block.content) });
        break;
      case "list":
        blocks.push({ blockId: block.id, type: block.type, text: block.items.map(inlineText).join("\n") });
        break;
      case "table":
        // One manifest line per CELL, not per row: `docx-generate.ts` renders
        // every table cell as its own `<w:p>` paragraph with no literal tab
        // character joining cells, so a tab-joined "col1\tcol2" row line (the
        // original approach here) can never be found by `extractDocxPlainText`,
        // which reconstructs text per paragraph. That mismatch made this check
        // fail closed on every table (see docs/office/acceptance-report.md).
        blocks.push({
          blockId: block.id,
          type: block.type,
          text: [
            ...block.columns.map((c) => c.title),
            ...block.rows.flatMap((row) => row.cells.map((cell) => inlineText(cell.content))),
          ].join("\n"),
          tableRows: block.rows.length,
          tableColumns: block.columns.length,
        });
        break;
      case "image":
        blocks.push({ blockId: block.id, type: block.type, text: block.caption ?? "", imageAssetId: block.assetId });
        break;
      case "pageBreak":
        blocks.push({ blockId: block.id, type: block.type, text: "" });
        break;
    }
  }
  return { requestId: spec.requestId, title: spec.title, blocks };
}

export interface ManifestDiffIssue {
  readonly code: "block-missing" | "block-text-mismatch" | "table-shape-mismatch" | "extraction-failed";
  readonly blockId?: string;
  readonly message: string;
}

/**
 * Extract a comparable manifest back out of a generated DOCX buffer by
 * reading `word/document.xml` text runs in document order and re-grouping
 * them by paragraph/table boundaries. This intentionally does not try to
 * recover block IDs (DOCX has none) — the diff below matches by position,
 * which is enough to catch "a block was silently dropped or rewritten
 * during layout" without needing round-trip IDs baked into the file.
 */
export function extractDocxPlainText(buffer: Uint8Array): string {
  const files = unzipSync(buffer);
  const xml = files["word/document.xml"];
  if (!xml) throw new Error("生成的 DOCX 缺少 word/document.xml，无法核对内容。");
  const text = new TextDecoder("utf-8").decode(xml);
  // A conservative, dependency-free run-text extraction: every <w:t>...</w:t>,
  // in document order, concatenated with paragraph boundaries as newlines.
  const runs: string[] = [];
  const paragraphRegex = /<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g;
  let match: RegExpExecArray | null;
  while ((match = paragraphRegex.exec(text))) {
    const paragraphXml = match[1] ?? "";
    const textRegex = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
    let textMatch: RegExpExecArray | null;
    const pieces: string[] = [];
    while ((textMatch = textRegex.exec(paragraphXml))) {
      pieces.push(decodeXmlEntities(textMatch[1] ?? ""));
    }
    runs.push(pieces.join(""));
  }
  return runs.join("\n");
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Content-presence check: every non-empty manifest text fragment must be
 * findable, in order, somewhere in the extracted plain text. This is
 * deliberately coarse (it does not reconstruct exact paragraph boundaries
 * from OOXML, which vary legitimately with layout) but it is exactly the
 * check that catches W31 (a deleted paragraph or table row): text that was
 * in the accepted content and is no longer anywhere in the output.
 */
export function diffManifestAgainstDocx(manifest: ContentManifest, docxBuffer: Uint8Array): readonly ManifestDiffIssue[] {
  let extracted: string;
  try {
    extracted = extractDocxPlainText(docxBuffer);
  } catch (error) {
    return [{ code: "extraction-failed", message: error instanceof Error ? error.message : String(error) }];
  }
  const issues: ManifestDiffIssue[] = [];
  let cursor = 0;
  for (const block of manifest.blocks) {
    if (block.type === "pageBreak") continue;
    const fragments = block.text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
    for (const fragment of fragments) {
      const index = extracted.indexOf(fragment, cursor);
      if (index === -1) {
        // Retry from the start once — content-manifest order can legitimately
        // differ from extraction order across a landscape-section split, so a
        // strict monotonic cursor would over-report false positives there.
        const anywhere = extracted.indexOf(fragment);
        if (anywhere === -1) {
          issues.push({
            code: "block-missing",
            blockId: block.blockId,
            message: `block ${block.blockId} 的内容“${truncate(fragment)}”在生成文档中未找到，可能在排版过程中被删除。`,
          });
          continue;
        }
        cursor = anywhere + fragment.length;
        continue;
      }
      cursor = index + fragment.length;
    }
  }
  return issues;
}

function truncate(value: string): string {
  return value.length > 40 ? `${value.slice(0, 40)}…` : value;
}
