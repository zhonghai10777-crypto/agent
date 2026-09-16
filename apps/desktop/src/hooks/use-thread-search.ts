import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TranscriptMessage } from "../desktop-state";
import { buildDisplayTimelineItems, searchableTextForTimelineItem } from "../timeline-turns";

const SEARCH_DEBOUNCE_MS = 150;

export interface ThreadSearchMatch {
  readonly itemId: string;
  /** This occurrence's position among matches within the same item, in document
   * (source-text) order — e.g. the 2nd hit inside one long message is 1, not a
   * position within the whole transcript. Lets the renderer line up a specific
   * on-screen occurrence with this match without the hook touching the DOM. */
  readonly occurrenceIndex: number;
}

function collectMatchesInText(text: string, lowerQuery: string, itemId: string, out: ThreadSearchMatch[]): void {
  if (!text) {
    return;
  }
  const lowerText = text.toLowerCase();
  let occurrenceIndex = 0;
  let fromIndex = 0;
  let foundAt = lowerText.indexOf(lowerQuery, fromIndex);
  while (foundAt !== -1) {
    out.push({ itemId, occurrenceIndex });
    occurrenceIndex += 1;
    fromIndex = foundAt + lowerQuery.length;
    foundAt = lowerText.indexOf(lowerQuery, fromIndex);
  }
}

/**
 * Owns thread search state and matching only — no DOM access. Matching runs
 * against the *source* text of every item produced by buildDisplayTimelineItems
 * (the same builder the timeline renders from), independent of virtualization or
 * scroll position, so a search always covers the whole thread and markdown source
 * markers (e.g. `**bold**`) participate in a match the way they'd read in the
 * composer. Scrolling to and highlighting the active match are the timeline
 * renderer's job (conversation-timeline.tsx), reacting to `activeMatch` below.
 */
export function useThreadSearch(transcript: readonly TranscriptMessage[]) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const displayItems = useMemo(() => buildDisplayTimelineItems(transcript), [transcript]);

  const matches = useMemo<readonly ThreadSearchMatch[]>(() => {
    const trimmed = debouncedQuery.trim();
    if (!trimmed) {
      return [];
    }
    const lowerQuery = trimmed.toLowerCase();
    const result: ThreadSearchMatch[] = [];
    for (const item of displayItems) {
      collectMatchesInText(searchableTextForTimelineItem(item), lowerQuery, item.id, result);
    }
    return result;
  }, [displayItems, debouncedQuery]);

  const search = useCallback((nextQuery: string) => {
    setQuery(nextQuery);
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    if (!nextQuery.trim()) {
      setDebouncedQuery("");
      setActiveIndex(-1);
      return;
    }
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      setDebouncedQuery(nextQuery);
      setActiveIndex(0);
    }, SEARCH_DEBOUNCE_MS);
  }, []);

  // Keeps activeIndex in range if the transcript changes (e.g. streaming) while a
  // search is open and shrinks the match set out from under the current index —
  // search() already sets a fresh activeIndex when the query itself changes, so
  // this only matters for that unrelated case.
  useEffect(() => {
    setActiveIndex((current) => {
      if (matches.length === 0) {
        return -1;
      }
      if (current < 0) {
        return current;
      }
      return Math.min(current, matches.length - 1);
    });
  }, [matches.length]);

  const goToMatch = useCallback((direction: 1 | -1) => {
    setActiveIndex((current) => {
      if (matches.length === 0) {
        return -1;
      }
      const base = current < 0 ? 0 : current;
      return (base + direction + matches.length) % matches.length;
    });
  }, [matches.length]);

  const open = useCallback(() => {
    setIsOpen(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
    setQuery("");
    setDebouncedQuery("");
    setActiveIndex(-1);
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
  }, []);

  return useMemo(
    () => ({
      isOpen,
      query,
      matchCount: matches.length,
      activeIndex,
      matches,
      /** The query that actually produced `matches` (debounced) — the DOM highlight
       * rebuild in conversation-timeline.tsx re-scans rendered rows against this,
       * not the raw input, so it never highlights a stale keystroke's text. */
      matchedQuery: debouncedQuery,
      activeMatch: activeIndex >= 0 ? matches[activeIndex] : undefined,
      inputRef,
      open,
      close,
      search,
      goToMatch,
    }),
    [isOpen, query, matches, debouncedQuery, activeIndex, open, close, search, goToMatch],
  );
}

export type ThreadSearchState = ReturnType<typeof useThreadSearch>;
