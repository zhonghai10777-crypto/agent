/**
 * Versioned style profiles (Task Order §7).
 *
 * A style profile is a program asset, not a prompt the model re-invents each
 * time. Units are normalized here (mm for page geometry, pt for type, plain
 * ratios for line spacing) and converted to the `docx` library's twips/half
 * points only inside `docx-generate.ts`, so this file stays the single
 * source of truth for "what a document type looks like".
 */

export interface PageGeometryMm {
  readonly widthMm: number;
  readonly heightMm: number;
  readonly marginTopMm: number;
  readonly marginRightMm: number;
  readonly marginBottomMm: number;
  readonly marginLeftMm: number;
}

export interface FontChoice {
  readonly eastAsian: string;
  readonly latin: string;
}

export interface HeadingStyleSpec {
  readonly sizePt: number;
  readonly bold: boolean;
  readonly spaceAfterPt: number;
  readonly keepNext: boolean;
}

export interface StyleProfile {
  readonly id: string;
  readonly version: 1;
  readonly displayName: string;
  readonly description: string;
  readonly page: PageGeometryMm;
  readonly bodyFont: FontChoice;
  readonly bodySizePt: number;
  readonly bodyLineSpacing: number; // multiple, e.g. 1.5
  readonly bodySpaceAfterPt: number;
  readonly bodyFirstLineIndentChars: number; // 0 disables first-line indent
  readonly titleSizePt: number;
  readonly headings: { readonly h1: HeadingStyleSpec; readonly h2: HeadingStyleSpec; readonly h3: HeadingStyleSpec };
  readonly tableFontSizePt: number;
  readonly tableCellPaddingTwips: number;
  readonly listHangingIndentTwips: number;
  readonly headerFooterFont: FontChoice;
  readonly headerFooterSizePt: number;
}

// A4, per §7.1. widthMm/heightMm are portrait; landscape tables swap them in
// docx-generate.ts's section-break logic rather than here.
const A4: PageGeometryMm = { widthMm: 210, heightMm: 297, marginTopMm: 25.4, marginRightMm: 25.4, marginBottomMm: 25.4, marginLeftMm: 25.4 };

const ZH_FONT: FontChoice = { eastAsian: "Noto Serif CJK SC", latin: "Times New Roman" };
const ZH_SANS_FONT: FontChoice = { eastAsian: "Noto Sans CJK SC", latin: "Calibri" };

function headings(base: number): StyleProfile["headings"] {
  return {
    h1: { sizePt: base, bold: true, spaceAfterPt: 12, keepNext: true },
    h2: { sizePt: Math.round(base * 0.875), bold: true, spaceAfterPt: 8, keepNext: true },
    h3: { sizePt: Math.round(base * 0.75), bold: true, spaceAfterPt: 6, keepNext: true },
  };
}

/** §7.1 default plain Chinese report profile. */
export const REPORT_ZH: StyleProfile = {
  id: "report-zh",
  version: 1,
  displayName: "中文报告",
  description: "标题层级 + 正文 + 表格的通用中文报告格式（A4，1.5 倍行距，首行缩进 2 字符）。",
  page: A4,
  bodyFont: ZH_FONT,
  bodySizePt: 12,
  bodyLineSpacing: 1.5,
  bodySpaceAfterPt: 6,
  bodyFirstLineIndentChars: 2,
  titleSizePt: 20,
  headings: headings(16),
  tableFontSizePt: 10.5,
  tableCellPaddingTwips: 100,
  listHangingIndentTwips: 480,
  headerFooterFont: ZH_FONT,
  headerFooterSizePt: 9,
};

/** Meeting minutes: no first-line indent (minutes are scanned, not read as prose), tighter spacing. */
export const MEETING_MINUTES_ZH: StyleProfile = {
  id: "meeting-minutes-zh",
  version: 1,
  displayName: "会议纪要",
  description: "无首行缩进、紧凑段距的会议纪要格式，适合议题/决议/行动项列表。",
  page: A4,
  bodyFont: ZH_SANS_FONT,
  bodySizePt: 12,
  bodyLineSpacing: 1.15,
  bodySpaceAfterPt: 4,
  bodyFirstLineIndentChars: 0,
  titleSizePt: 18,
  headings: headings(15),
  tableFontSizePt: 10.5,
  tableCellPaddingTwips: 90,
  listHangingIndentTwips: 420,
  headerFooterFont: ZH_SANS_FONT,
  headerFooterSizePt: 9,
};

/** Implementation plan: same body rhythm as the report profile but a slightly larger title and tighter table type for dense schedules. */
export const IMPLEMENTATION_PLAN_ZH: StyleProfile = {
  id: "implementation-plan-zh",
  version: 1,
  displayName: "实施方案",
  description: "面向任务分解、进度和责任人表格的实施方案格式。",
  page: A4,
  bodyFont: ZH_FONT,
  bodySizePt: 12,
  bodyLineSpacing: 1.5,
  bodySpaceAfterPt: 6,
  bodyFirstLineIndentChars: 2,
  titleSizePt: 20,
  headings: headings(16),
  tableFontSizePt: 10.5,
  tableCellPaddingTwips: 100,
  listHangingIndentTwips: 480,
  headerFooterFont: ZH_FONT,
  headerFooterSizePt: 9,
};

/** Lesson plan: sans body font for on-screen projection, larger heading rhythm for section scanning. */
export const LESSON_PLAN_ZH: StyleProfile = {
  id: "lesson-plan-zh",
  version: 1,
  displayName: "教学设计",
  description: "面向课堂教学设计的格式：无衬线正文、清晰的环节标题层级。",
  page: A4,
  bodyFont: ZH_SANS_FONT,
  bodySizePt: 12,
  bodyLineSpacing: 1.5,
  bodySpaceAfterPt: 6,
  bodyFirstLineIndentChars: 0,
  titleSizePt: 20,
  headings: headings(16),
  tableFontSizePt: 10.5,
  tableCellPaddingTwips: 100,
  listHangingIndentTwips: 480,
  headerFooterFont: ZH_SANS_FONT,
  headerFooterSizePt: 9,
};

export const BUILT_IN_STYLE_PROFILES: readonly StyleProfile[] = [
  REPORT_ZH,
  MEETING_MINUTES_ZH,
  IMPLEMENTATION_PLAN_ZH,
  LESSON_PLAN_ZH,
];

export function findStyleProfile(id: string): StyleProfile | undefined {
  return BUILT_IN_STYLE_PROFILES.find((profile) => profile.id === id);
}

export const BUILT_IN_STYLE_PROFILE_IDS: readonly string[] = BUILT_IN_STYLE_PROFILES.map((profile) => profile.id);
