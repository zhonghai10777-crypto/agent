/**
 * DocumentSpec -> real `docx` library Document.
 *
 * This is the only place that talks to the `docx` package. Everything else
 * in the office pipeline works with the application-level `DocumentSpec`
 * contract (contracts.ts) and `StyleProfile` (style-profiles.ts). No raw
 * OOXML string-splicing happens here — every paragraph, table, list and
 * image goes through the library's object model so `word/styles.xml`,
 * numbering and relationships are always internally consistent (fixes B02
 * from the task order: the previous hand-rolled generator referenced
 * `Heading1` without ever emitting a styles part).
 */
import {
  AlignmentType,
  Document,
  ExternalHyperlink,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  PageBreak,
  PageNumber,
  Paragraph,
  SectionType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
  type IStylesOptions,
  type ISectionOptions,
  type ParagraphChild,
} from "docx";
import type { Block, DocumentSpec, Inline, RegisteredImageAsset } from "./contracts";
import { resolveColumnWidths } from "./contracts";
import type { StyleProfile } from "./style-profiles";

const TWIPS_PER_MM = 56.6929133858; // 1440 twips per inch / 25.4 mm per inch
const HALF_POINTS_PER_PT = 2;

function mmToTwips(mm: number): number {
  return Math.round(mm * TWIPS_PER_MM);
}
function ptToHalfPt(pt: number): number {
  return Math.round(pt * HALF_POINTS_PER_PT);
}
function charsToTwips(chars: number, bodySizePt: number): number {
  // First-line indent in "characters": one full-width CJK character is
  // approximately one em at the body font size. 1pt == 20 twips.
  return Math.round(chars * bodySizePt * 20);
}

export interface GenerateOptions {
  readonly spec: DocumentSpec;
  readonly styleProfile: StyleProfile;
  readonly resolveImage: (assetId: string) => RegisteredImageAsset;
  readonly onFontFallback?: (info: { readonly requested: string; readonly fallback: string }) => void;
}

/** Content-manifest-relevant text extracted while walking inline runs, kept in lockstep with the generated paragraph so `content-manifest.ts` can diff against it later without re-walking the DocumentSpec. */
export interface GenerateResult {
  readonly document: Document;
}

export function generateDocxDocument(options: GenerateOptions): GenerateResult {
  const { spec, styleProfile: sp } = options;

  const font = { ascii: sp.bodyFont.latin, hAnsi: sp.bodyFont.latin, eastAsia: sp.bodyFont.eastAsian };
  const headerFooterFont = {
    ascii: sp.headerFooterFont.latin,
    hAnsi: sp.headerFooterFont.latin,
    eastAsia: sp.headerFooterFont.eastAsian,
  };

  const styles: IStylesOptions = {
    default: {
      document: {
        run: { font, size: ptToHalfPt(sp.bodySizePt) },
        paragraph: {
          spacing: { line: Math.round(sp.bodyLineSpacing * 240), lineRule: "auto", after: ptToHalfPt(sp.bodySpaceAfterPt) * 10 },
        },
      },
      title: {
        run: { font, size: ptToHalfPt(sp.titleSizePt), bold: true },
        paragraph: { alignment: AlignmentType.CENTER, spacing: { after: 240 } },
      },
      heading1: {
        run: { font, size: ptToHalfPt(sp.headings.h1.sizePt), bold: sp.headings.h1.bold },
        paragraph: { spacing: { after: ptToHalfPt(sp.headings.h1.spaceAfterPt) * 10 }, keepNext: sp.headings.h1.keepNext },
      },
      heading2: {
        run: { font, size: ptToHalfPt(sp.headings.h2.sizePt), bold: sp.headings.h2.bold },
        paragraph: { spacing: { after: ptToHalfPt(sp.headings.h2.spaceAfterPt) * 10 }, keepNext: sp.headings.h2.keepNext },
      },
      heading3: {
        run: { font, size: ptToHalfPt(sp.headings.h3.sizePt), bold: sp.headings.h3.bold },
        paragraph: { spacing: { after: ptToHalfPt(sp.headings.h3.spaceAfterPt) * 10 }, keepNext: sp.headings.h3.keepNext },
      },
      listParagraph: {
        run: { font, size: ptToHalfPt(sp.bodySizePt) },
      },
    },
  };

  // One independent numbering "reference" per list block: numbering never
  // bleeds between two `list` blocks (Task Order W05), because each gets its
  // own abstract/concrete numbering instance instead of sharing one counter.
  const numberingConfigs = spec.blocks
    .filter((block): block is Extract<Block, { type: "list" }> => block.type === "list")
    .map((block) => ({
      reference: `list-${block.id}`,
      levels: [
        {
          level: 0,
          format: block.ordered ? LevelFormat.DECIMAL : LevelFormat.BULLET,
          text: block.ordered ? "%1." : "•",
          alignment: AlignmentType.LEFT,
          style: {
            paragraph: {
              indent: { left: sp.listHangingIndentTwips, hanging: sp.listHangingIndentTwips / 2 },
            },
          },
        },
      ],
    }));

  const headerChildren = spec.header ? [paragraphFromInline(spec.header, headerFooterFont, sp.headerFooterSizePt, options)] : [];
  const footerChildren: Paragraph[] = [];
  if (spec.footer) footerChildren.push(paragraphFromInline(spec.footer, headerFooterFont, sp.headerFooterSizePt, options));
  if (spec.pageNumbers) {
    footerChildren.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({ font: headerFooterFont, size: ptToHalfPt(sp.headerFooterSizePt), children: [PageNumber.CURRENT] }),
          new TextRun({ font: headerFooterFont, size: ptToHalfPt(sp.headerFooterSizePt), text: " / " }),
          new TextRun({ font: headerFooterFont, size: ptToHalfPt(sp.headerFooterSizePt), children: [PageNumber.TOTAL_PAGES] }),
        ],
      }),
    );
  }
  const header = headerChildren.length ? new Header({ children: headerChildren }) : undefined;
  const footer = footerChildren.length ? new Footer({ children: footerChildren }) : undefined;

  const portraitPage = {
    size: { width: mmToTwips(sp.page.widthMm), height: mmToTwips(sp.page.heightMm), orientation: "portrait" as const },
    margin: {
      top: mmToTwips(sp.page.marginTopMm),
      right: mmToTwips(sp.page.marginRightMm),
      bottom: mmToTwips(sp.page.marginBottomMm),
      left: mmToTwips(sp.page.marginLeftMm),
    },
  };
  // `docx`'s `createPageSize` swaps width/height itself whenever orientation
  // is "landscape" (it always wants the *portrait* dimensions in, and flips
  // them at XML-build time) — passing already-swapped dimensions here would
  // double-swap and silently produce a portrait page again.
  const landscapePage = {
    size: { width: mmToTwips(sp.page.widthMm), height: mmToTwips(sp.page.heightMm), orientation: "landscape" as const },
    margin: portraitPage.margin,
  };

  // Split into sections whenever a landscape table appears, so the page
  // orientation change is scoped to that table and the following content
  // returns to portrait automatically (Task Order §6.1 "横向布局...不能任意
  // 改变页边距来逃避检查", §9.2 landscape-then-restore requirement).
  const sections: ISectionOptions[] = [];
  let currentChildren: (Paragraph | Table)[] = [];
  const flushSection = (page: typeof portraitPage | typeof landscapePage) => {
    sections.push({
      properties: { page, titlePage: false },
      headers: header ? { default: header } : undefined,
      footers: footer ? { default: footer } : undefined,
      children: currentChildren,
    });
    currentChildren = [];
  };

  const titleParagraph = spec.title
    ? new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: spec.title })] })
    : undefined;
  if (titleParagraph) currentChildren.push(titleParagraph);

  for (const block of spec.blocks) {
    if (block.type === "table" && block.layout === "landscape") {
      flushSection(portraitPage);
      currentChildren.push(buildTable(block, sp, options));
      flushSection(landscapePage);
      continue;
    }
    if (block.type === "list") {
      currentChildren.push(...expandListParagraphs(block, options));
      continue;
    }
    if (block.type === "image" && block.caption) {
      currentChildren.push(buildImageParagraph(block, options));
      currentChildren.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: block.caption, italics: true, size: ptToHalfPt(sp.tableFontSizePt) })],
        }),
      );
      continue;
    }
    const node = buildBlock(block, sp, options, numberingConfigs.length > 0);
    if (node) currentChildren.push(node);
  }
  flushSection(portraitPage);

  const document = new Document({
    styles,
    numbering: numberingConfigs.length ? { config: numberingConfigs } : undefined,
    sections,
    title: spec.title,
  });

  return { document };
}

function buildBlock(
  block: Block,
  sp: StyleProfile,
  options: GenerateOptions,
  _hasNumbering: boolean,
): Paragraph | Table | undefined {
  switch (block.type) {
    case "heading": {
      const headingLevel =
        block.level === 1 ? HeadingLevel.HEADING_1 : block.level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3;
      return new Paragraph({ heading: headingLevel, children: inlineChildren(block.content, options) });
    }
    case "paragraph": {
      const firstLine =
        block.role !== "note" && sp.bodyFirstLineIndentChars > 0
          ? charsToTwips(sp.bodyFirstLineIndentChars, sp.bodySizePt)
          : undefined;
      return new Paragraph({
        indent: firstLine ? { firstLine } : undefined,
        children: inlineChildren(block.content, options),
      });
    }
    case "list":
      return undefined; // lists expand to multiple paragraphs; handled by caller loop below
    case "table":
      return buildTable(block, sp, options);
    case "image":
      return buildImageParagraph(block, options);
    case "pageBreak":
      return new Paragraph({ children: [new PageBreak()] });
    default:
      return undefined;
  }
}

// `list` blocks need to become N paragraphs, one per item, so they cannot be
// produced by the single-node `buildBlock` above; the main loop special-cases
// them here before falling through to `buildBlock` for everything else.
function expandListParagraphs(block: Extract<Block, { type: "list" }>, options: GenerateOptions): Paragraph[] {
  return block.items.map(
    (item) =>
      new Paragraph({
        numbering: { reference: `list-${block.id}`, level: 0 },
        children: inlineChildren(item, options),
      }),
  );
}

function inlineChildren(content: readonly Inline[], options: GenerateOptions): ParagraphChild[] {
  const children: ParagraphChild[] = [];
  for (const inline of content) {
    if (inline.type === "text") {
      children.push(new TextRun({ text: inline.text, bold: inline.bold, italics: inline.italic }));
    } else if (inline.type === "lineBreak") {
      children.push(new TextRun({ text: "", break: 1 }));
    } else if (inline.type === "link") {
      children.push(
        new ExternalHyperlink({
          link: inline.href,
          children: [new TextRun({ text: inline.text, style: "Hyperlink" })],
        }),
      );
    }
  }
  return children;
}

function paragraphFromInline(content: readonly Inline[], font: { ascii: string; hAnsi: string; eastAsia: string }, sizePt: number, options: GenerateOptions): Paragraph {
  return new Paragraph({
    children: content.map((inline) =>
      inline.type === "text"
        ? new TextRun({ text: inline.text, bold: inline.bold, italics: inline.italic, font, size: ptToHalfPt(sizePt) })
        : inline.type === "lineBreak"
          ? new TextRun({ text: "", break: 1 })
          : new ExternalHyperlink({ link: inline.href, children: [new TextRun({ text: inline.text, font, size: ptToHalfPt(sizePt) })] }),
    ),
  });
}

const TABLE_TOTAL_WIDTH_TWIPS = 9360; // A4 content width at 25.4mm margins, matches portraitPage above

function buildTable(block: Extract<Block, { type: "table" }>, sp: StyleProfile, options: GenerateOptions): Table {
  const columnWidths = resolveColumnWidths(block.columns, TABLE_TOTAL_WIDTH_TWIPS);
  const headerRow = new TableRow({
    tableHeader: true,
    children: block.columns.map(
      (column, index) =>
        new TableCell({
          width: { size: columnWidths[index] ?? 0, type: WidthType.DXA },
          margins: {
            top: sp.tableCellPaddingTwips,
            bottom: sp.tableCellPaddingTwips,
            left: sp.tableCellPaddingTwips,
            right: sp.tableCellPaddingTwips,
          },
          verticalAlign: VerticalAlign.CENTER,
          children: [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [new TextRun({ text: column.title, bold: true, size: ptToHalfPt(sp.tableFontSizePt) })],
            }),
          ],
        }),
    ),
  });
  const bodyRows = block.rows.map(
    (row) =>
      new TableRow({
        children: row.cells.map(
          (cell, index) =>
            new TableCell({
              width: { size: columnWidths[index] ?? 0, type: WidthType.DXA },
              margins: {
                top: sp.tableCellPaddingTwips,
                bottom: sp.tableCellPaddingTwips,
                left: sp.tableCellPaddingTwips,
                right: sp.tableCellPaddingTwips,
              },
              children: [
                new Paragraph({
                  children: cell.content.map((inline) =>
                    inline.type === "text"
                      ? new TextRun({ text: inline.text, bold: inline.bold, italics: inline.italic, size: ptToHalfPt(sp.tableFontSizePt) })
                      : inline.type === "lineBreak"
                        ? new TextRun({ text: "", break: 1, size: ptToHalfPt(sp.tableFontSizePt) })
                        : new ExternalHyperlink({
                            link: inline.href,
                            children: [new TextRun({ text: inline.text, size: ptToHalfPt(sp.tableFontSizePt) })],
                          }),
                  ),
                }),
              ],
            }),
        ),
      }),
  );
  return new Table({
    width: { size: TABLE_TOTAL_WIDTH_TWIPS, type: WidthType.DXA },
    columnWidths,
    rows: [headerRow, ...bodyRows],
  });
}

const MAX_IMAGE_WIDTH_TWIPS = TABLE_TOTAL_WIDTH_TWIPS;
const TWIPS_PER_PX_AT_96DPI = 15; // 1440 twips/inch / 96 px/inch

function buildImageParagraph(block: Extract<Block, { type: "image" }>, options: GenerateOptions): Paragraph {
  const asset = options.resolveImage(block.assetId);
  const naturalWidthTwips = asset.widthPx * TWIPS_PER_PX_AT_96DPI;
  const scale = naturalWidthTwips > MAX_IMAGE_WIDTH_TWIPS ? MAX_IMAGE_WIDTH_TWIPS / naturalWidthTwips : 1;
  const widthPx = Math.round(asset.widthPx * scale);
  const heightPx = Math.round(asset.heightPx * scale);
  const children: ParagraphChild[] = [
    new ImageRun({
      type: asset.mimeType === "image/png" ? "png" : "jpg",
      data: asset.buffer,
      transformation: { width: widthPx, height: heightPx },
      altText: { title: block.alt, description: block.alt, name: block.assetId },
    }),
  ];
  const imageParagraph = new Paragraph({ alignment: AlignmentType.CENTER, children });
  return imageParagraph;
}

export { expandListParagraphs };
