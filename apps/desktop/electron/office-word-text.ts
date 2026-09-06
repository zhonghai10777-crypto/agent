import { DOMParser, XMLSerializer } from "@xmldom/xmldom";

const WORD_NAMESPACES = new Set([
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  "http://purl.oclc.org/ooxml/wordprocessingml/main",
]);
const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";
const TEXT_BARRIERS = new Set([
  "p", "br", "cr", "tab", "fldChar", "instrText", "del", "moveFrom",
  "drawing", "pict", "object", "sym", "noBreakHyphen", "softHyphen",
]);

interface TextSpan {
  readonly element: Element;
  readonly text: string;
  readonly start: number;
}

/** Match visible paragraph text; the replacement inherits its first run's format. */
export function replaceWordDocumentXml(
  xml: string,
  search: string,
  replacement: string,
): { xml: string; changedItems: number } {
  if (!search) throw new Error("word_replace requires non-empty search text.");
  let invalid = false;
  const document = new DOMParser({
    errorHandler: () => { invalid = true; },
  }).parseFromString(xml, "application/xml");
  if (invalid || !document.documentElement || document.doctype) {
    throw new Error("Word 文档 XML 结构无效，无法安全替换文字。");
  }

  let changedItems = 0;
  const paragraphs = Array.from(document.getElementsByTagNameNS("*", "p"))
    .filter((element) => WORD_NAMESPACES.has(element.namespaceURI ?? ""));
  for (const paragraph of paragraphs) {
    let spans: TextSpan[] = [];
    let length = 0;
    const flush = () => {
      changedItems += replaceSpans(spans, search, replacement);
      spans = [];
      length = 0;
    };
    const visit = (parent: Node) => {
      for (let child = parent.firstChild; child; child = child.nextSibling) {
        if (child.nodeType !== 1) continue;
        const element = child as Element;
        if (WORD_NAMESPACES.has(element.namespaceURI ?? "")) {
          if (TEXT_BARRIERS.has(element.localName)) {
            flush();
            continue; // Nested paragraphs are handled separately, never twice.
          }
          if (element.localName === "t") {
            const text = element.textContent ?? "";
            if (text) spans.push({ element, text, start: length });
            length += text.length;
            continue;
          }
        }
        visit(element);
      }
    };
    visit(paragraph);
    flush();
  }
  return {
    xml: changedItems ? new XMLSerializer().serializeToString(document) : xml,
    changedItems,
  };
}

function replaceSpans(spans: readonly TextSpan[], search: string, replacement: string): number {
  const text = spans.map((span) => span.text).join("");
  const matches: number[] = [];
  for (let index = text.indexOf(search); index >= 0; index = text.indexOf(search, index + search.length)) {
    matches.push(index);
  }

  // Apply from right to left so offsets before each match remain unchanged.
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const start = matches[index]!;
    const end = start + search.length;
    const first = spanAt(spans, start);
    const last = spanAt(spans, end - 1);
    for (let node = first; node <= last; node += 1) {
      const span = spans[node]!;
      const current = span.element.textContent ?? "";
      const prefix = node === first ? current.slice(0, start - span.start) + replacement : "";
      const suffix = node === last ? current.slice(end - span.start) : "";
      const next = prefix + suffix;
      span.element.textContent = next;
      if (/^\s|\s$/u.test(next)) span.element.setAttributeNS(XML_NAMESPACE, "xml:space", "preserve");
    }
  }
  return matches.length;
}

function spanAt(spans: readonly TextSpan[], offset: number): number {
  let low = 0;
  let high = spans.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (spans[middle]!.start <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}
