import { createHash } from "node:crypto";

/**
 * In-memory snapshot store for `web_fetch` results, so a long page can be
 * read back section by section (`web_read`) without re-fetching it and
 * without ever writing anything to disk — this is a pure process-lifetime
 * cache, not a persistence layer. Deliberately mirrors the shape of
 * `document-cache.ts`'s in-memory document cache (key, LRU eviction by both
 * character budget and entry count) without sharing code with it: a web page
 * has no filesystem mtime to version by, so the cache key here is the page's
 * own URL and the version is a content hash — different enough from the
 * file-identity versioning document-cache.ts does that forcing a shared
 * abstraction would cost more than it saves.
 */

/**
 * Text handed to the model per `web_fetch`/`web_read` call. `extractReadableText`
 * (see web-search.ts) already emits one line per block-level element
 * (paragraph, table row, heading, list item, ...), so packing whole lines up
 * to this budget naturally avoids cutting a paragraph or a table row in half;
 * only a single line that alone exceeds the budget is ever hard-split, and
 * even then at a sentence or word boundary — see `splitLongLine` below.
 */
const PART_CHAR_BUDGET = 12_000;

/**
 * Total in-memory cache bound, in characters. Each entry is capped at
 * `MAX_EXTRACT_CHARS` (400,000, see web-search.ts), so this bound is sized to
 * hold a meaningful number of previously-fetched pages across one long agent
 * session — a few MB — without growing unbounded; it is the same order of
 * magnitude as `document-cache.ts`'s own in-memory bound (4.5M chars) for the
 * same reason: both are "keep recent working set, not everything ever read".
 */
const MAX_CACHED_CHARS = 6_000_000;
/** Also bound by entry count, so many small pages cannot otherwise leave
 * hundreds of stale map entries alive under the character budget alone. */
const MAX_CACHE_ENTRIES = 64;

export interface WebContentSnapshot {
  readonly url: string;
  readonly title: string;
  readonly parts: readonly string[];
  /** sha256(text) hex, first 16 chars. A web page has no mtime to version by,
   * so content identity is the only reliable "has this changed" signal. */
  readonly sourceVersion: string;
  /** False when extraction hit `charLimit` (or the fetch itself was
   * byte-capped) — i.e. content beyond what was captured may still exist,
   * distinct from "totalParts > 1", which just means what WAS captured is
   * long enough to need paging. */
  readonly complete: boolean;
  readonly charLimit: number;
}

interface CacheEntry {
  readonly snapshot: WebContentSnapshot;
  readonly chars: number;
}

const cache = new Map<string, CacheEntry>();
let cachedChars = 0;

export interface CacheWebFetchInput {
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly complete: boolean;
  readonly charLimit: number;
}

/**
 * Stores (or overwrites) one page's extracted text, keyed by its final URL —
 * i.e. after redirects, not necessarily the URL `web_fetch` was originally
 * asked for. Called by `runWebFetch` as a side effect of every successful
 * fetch. `web_read` only ever reads from this store (`getCachedWebContent`);
 * it never calls this and never triggers a network request.
 */
export function cacheWebFetch(input: CacheWebFetchInput): WebContentSnapshot {
  const sourceVersion = createHash("sha256").update(input.text, "utf8").digest("hex").slice(0, 16);
  const snapshot: WebContentSnapshot = {
    url: input.url,
    title: input.title,
    parts: segmentWebText(input.text),
    sourceVersion,
    complete: input.complete,
    charLimit: input.charLimit,
  };
  const entry: CacheEntry = { snapshot, chars: input.text.length };

  const old = cache.get(input.url);
  if (old) {
    cachedChars -= old.chars;
  }
  // Re-inserting (rather than mutating in place) moves the key to the most-
  // recently-used end of the Map's iteration order, which the eviction loop
  // below relies on.
  cache.delete(input.url);
  cache.set(input.url, entry);
  cachedChars += entry.chars;

  for (const [key, cached] of cache) {
    if (cachedChars <= MAX_CACHED_CHARS && cache.size <= MAX_CACHE_ENTRIES) {
      break;
    }
    cache.delete(key);
    cachedChars -= cached.chars;
  }

  return snapshot;
}

/** Read-only lookup — never fetches, never makes a network request. Touches
 * LRU order on a hit, same as a fresh write. */
export function getCachedWebContent(url: string): WebContentSnapshot | undefined {
  const hit = cache.get(url);
  if (!hit) {
    return undefined;
  }
  cache.delete(url);
  cache.set(url, hit);
  return hit.snapshot;
}

/** Test-only: this cache is process-lifetime module state, so tests that care
 * about eviction or about a clean "never fetched" starting point need a way
 * to reset it between runs instead of leaking entries across test files. */
export function resetWebContentCacheForTests(): void {
  cache.clear();
  cachedChars = 0;
}

// ---- segmentation ----

function segmentWebText(text: string): readonly string[] {
  if (!text) {
    return [];
  }
  if (text.length <= PART_CHAR_BUDGET) {
    return [text];
  }
  return packGreedy(splitIntoHeadingBlocks(text), splitOversizedBlock);
}

/**
 * Packs `items` into parts up to `PART_CHAR_BUDGET`, joining with newlines and
 * starting a new part rather than splitting an item across two. An item too
 * big to ever fit is handed to `onOversized`, which decides how to break it
 * down — that delegation is the only thing that differs between packing
 * heading blocks and packing the lines inside one oversized block, so the
 * greedy loop itself lives here once.
 */
function packGreedy(
  items: readonly string[],
  onOversized: (item: string) => readonly string[],
): readonly string[] {
  const parts: string[] = [];
  let current = "";
  for (const item of items) {
    if (item.length > PART_CHAR_BUDGET) {
      if (current) {
        parts.push(current);
        current = "";
      }
      parts.push(...onOversized(item));
      continue;
    }
    const candidate = current ? `${current}\n${item}` : item;
    if (candidate.length <= PART_CHAR_BUDGET) {
      current = candidate;
    } else {
      if (current) {
        parts.push(current);
      }
      current = item;
    }
  }
  if (current) {
    parts.push(current);
  }
  return parts;
}

const HEADING_LINE = /^#{1,6}\s/;

/** Groups lines so a heading always starts a new block together with the
 * content beneath it — the preferred cut point when a part boundary is
 * needed at all, ahead of an ordinary paragraph break. */
function splitIntoHeadingBlocks(text: string): readonly string[] {
  const lines = text.split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (HEADING_LINE.test(line) && current.length > 0) {
      blocks.push(current.join("\n"));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) {
    blocks.push(current.join("\n"));
  }
  return blocks;
}

/** A heading block too big to fit in one part on its own: pack it line by
 * line — each line is already one paragraph/table row/list item, per
 * `extractReadableText`'s output shape — falling back to a sentence- or
 * word-boundary cut only for a single line that alone exceeds the budget. */
function splitOversizedBlock(block: string): readonly string[] {
  return packGreedy(block.split("\n"), splitLongLine);
}

const SENTENCE_END = /[.!?。!?]\s/g;

/**
 * Hard-splits one line that alone exceeds the part budget (e.g. an unbroken
 * wall of text with no paragraph markup at all). Cuts at the last sentence
 * end inside the window when there is one, else the last word boundary, and
 * only cuts mid-word as a last resort — but always makes forward progress,
 * so a pathological line (no spaces, no punctuation) cannot loop forever.
 */
function splitLongLine(line: string): readonly string[] {
  const parts: string[] = [];
  let start = 0;
  while (start < line.length) {
    const remaining = line.length - start;
    if (remaining <= PART_CHAR_BUDGET) {
      parts.push(line.slice(start));
      break;
    }
    const window = line.slice(start, start + PART_CHAR_BUDGET);
    const breakAt = lastSentenceBreak(window) ?? lastWordBreak(window) ?? window.length;
    parts.push(line.slice(start, start + breakAt));
    start += breakAt;
  }
  return parts;
}

function lastSentenceBreak(window: string): number | undefined {
  SENTENCE_END.lastIndex = 0;
  let last: number | undefined;
  let match: RegExpExecArray | null;
  while ((match = SENTENCE_END.exec(window))) {
    last = match.index + match[0].length;
  }
  // A break in the first fifth of the window would make near-zero progress;
  // prefer the word-boundary fallback in that case instead.
  return last !== undefined && last > window.length * 0.2 ? last : undefined;
}

function lastWordBreak(window: string): number | undefined {
  const lastSpace = window.lastIndexOf(" ");
  return lastSpace > window.length * 0.2 ? lastSpace + 1 : undefined;
}
