/**
 * Minimal inline-text formatting for the model-facing tool schema.
 *
 * `word_compose`'s block schema takes a plain `text: string` per block
 * (see office-compose.ts) rather than requiring the model to hand-build
 * nested `Inline[]` objects for every run — that ceremony is exactly what
 * the task order warns against ("不能在模型上下文堆出数十个低层样式命令").
 * This does the minimal, safe subset of that formatting job: `**bold**` and
 * `*italic*` spans, nothing nested, no HTML, no arbitrary markup. Anything
 * that looks like unterminated syntax is left as literal text rather than
 * silently eaten.
 */
import type { Inline } from "./contracts";

export function parseInlineMarkdownText(text: string): Inline[] {
  const result: Inline[] = [];
  // Order matters: bold (**) must be tried before italic (*) so "**x**" is
  // not mis-split into two lone "*" italics.
  const pattern = /\*\*([^*]+)\*\*|\*([^*]+)\*/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    if (match.index > lastIndex) result.push({ type: "text", text: text.slice(lastIndex, match.index) });
    if (match[1] !== undefined) result.push({ type: "text", text: match[1], bold: true });
    else if (match[2] !== undefined) result.push({ type: "text", text: match[2], italic: true });
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < text.length) result.push({ type: "text", text: text.slice(lastIndex) });
  return result.length > 0 ? result : [{ type: "text", text: "" }];
}
