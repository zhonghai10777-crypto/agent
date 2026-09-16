/**
 * User-template (`.docx` with placeholders) support — Task Order §8.
 *
 * The default technical route names `docxtemplater` (open-core) + `pizzip`
 * for this. Neither could be installed this round: this environment's
 * cloud sandbox and the linked computer's execution shell both had no npm
 * registry egress when this was built (confirmed — see
 * docs/office/acceptance-report.md T04), and this module must not
 * silently fall back to a naive whole-file string replace instead (Task
 * Order §8.2 explicitly forbids that: "不能用对 document.xml 的简单全局
 * 字符串替换代替模板引擎").
 *
 * So this module is a genuine capability gate, not a fake one: it tries a
 * dynamic `import("docxtemplater")` / `import("pizzip")` at call time,
 * reports `unavailable` with a clear reason when they are not installed,
 * and — once they are added to the workspace the normal way (declared in
 * package.json, present in the lockfile, license-reviewed per §3.3) —
 * every function below starts working with no call-site changes.
 */
import { readFile } from "node:fs/promises";

export interface TemplateField {
  readonly name: string;
  readonly kind: "text" | "loop" | "condition";
  readonly required: boolean;
}
export interface TemplateInspection {
  readonly fields: readonly TemplateField[];
  readonly unsupportedObjects: readonly string[];
  readonly warnings: readonly string[];
}
export interface TemplateEngineAvailability {
  readonly available: boolean;
  readonly engine: "docxtemplater";
  readonly reason?: string;
}

async function loadEngine(): Promise<{ readonly PizZip: unknown; readonly Docxtemplater: unknown } | undefined> {
  try {
    // Intentionally dynamic via a non-literal specifier: a plain top-level
    // `import` (or even `import("pizzip")` with a literal string) would make
    // TypeScript try to statically resolve these optional packages and fail
    // the whole build when they are absent, instead of degrading this one
    // capability to "unavailable" at runtime. Routing the specifier through a
    // variable is the standard pattern for a genuinely optional dependency:
    // `import(expr)` only attempts declaration lookup when `expr` is a
    // string literal, so this keeps real dynamic-import semantics (still
    // literally imports "pizzip"/"docxtemplater" at runtime) while typing as
    // `Promise<any>` instead of erroring at compile time.
    const pizzipSpecifier: string = "pizzip";
    const docxtemplaterSpecifier: string = "docxtemplater";
    const pizzipModule = await import(/* @vite-ignore */ pizzipSpecifier);
    const docxtemplaterModule = await import(/* @vite-ignore */ docxtemplaterSpecifier);
    return { PizZip: pizzipModule.default ?? pizzipModule, Docxtemplater: docxtemplaterModule.default ?? docxtemplaterModule };
  } catch {
    return undefined;
  }
}

export async function checkTemplateEngineAvailability(): Promise<TemplateEngineAvailability> {
  const engine = await loadEngine();
  if (engine) return { available: true, engine: "docxtemplater" };
  return {
    available: false,
    engine: "docxtemplater",
    reason:
      "未安装模板引擎依赖（docxtemplater / pizzip）。本次会话的网络策略不允许安装新的 npm 依赖；" +
      "用户模板填充能力当前不可用，其余生成/渲染/检查能力不受影响。",
  };
}

const FIELD_PATTERN = /\{([#/^]?)([\w.$-]+)\}/g;

/** A best-effort, engine-independent field scan straight over the raw XML text, used only to power `inspect_template` while the real engine is unavailable — it never writes anything and is not used for the actual fill (that always requires the real engine, per §8.2). */
export async function inspectTemplateFieldsOffline(docxBuffer: Uint8Array): Promise<TemplateInspection> {
  const { unzipSync } = await import("fflate");
  const files = unzipSync(docxBuffer);
  const documentXml = files["word/document.xml"];
  if (!documentXml) return { fields: [], unsupportedObjects: [], warnings: ["未找到 word/document.xml。"] };
  const xml = new TextDecoder("utf-8").decode(documentXml);
  const fields = new Map<string, TemplateField>();
  let match: RegExpExecArray | null;
  while ((match = FIELD_PATTERN.exec(xml))) {
    const marker = match[1];
    const name = match[2];
    if (!name) continue;
    const kind = marker === "#" || marker === "/" ? "loop" : marker === "^" ? "condition" : "text";
    if (!fields.has(name)) fields.set(name, { name, kind, required: true });
  }
  const warnings: string[] = [];
  if (/\{[^}]*\d\s*[+\-*/]\s*\d[^}]*\}/.test(xml)) {
    warnings.push("检测到花括号内包含数学运算符的内容，已跳过，避免把普通数学花括号误判为模板字段。");
  }
  return { fields: [...fields.values()], unsupportedObjects: [], warnings };
}

export interface TemplateFillResult {
  readonly buffer: Uint8Array;
  readonly filledFields: readonly string[];
  readonly remainingPlaceholders: readonly string[];
}

export async function fillTemplate(
  templateBuffer: Uint8Array,
  data: Readonly<Record<string, unknown>>,
): Promise<TemplateFillResult> {
  const engine = await loadEngine();
  if (!engine) {
    throw new Error(
      "模板引擎不可用（未安装 docxtemplater/pizzip）。请先在有网络访问权限的环境中添加这两个依赖，再重试模板填充。",
    );
  }
  const PizZipCtor = engine.PizZip as new (data: Uint8Array) => { generate(options: { type: string }): Uint8Array };
  const DocxtemplaterCtor = engine.Docxtemplater as new (
    zip: unknown,
    options: { paragraphLoop: boolean; linebreaks: boolean },
  ) => { render(data: Record<string, unknown>): void; getZip(): { generate(options: { type: string }): Uint8Array } };

  const zip = new PizZipCtor(templateBuffer);
  const doc = new DocxtemplaterCtor(zip, { paragraphLoop: true, linebreaks: true });
  doc.render(data as Record<string, unknown>);
  const buffer = doc.getZip().generate({ type: "uint8array" as never }) as unknown as Uint8Array;

  const inspectionAfter = await inspectTemplateFieldsOffline(buffer);
  return {
    buffer,
    filledFields: Object.keys(data),
    remainingPlaceholders: inspectionAfter.fields.map((field) => field.name),
  };
}

export async function loadTemplateFromDisk(templatePath: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(templatePath));
}
