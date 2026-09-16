import { useCallback, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MutableRefObject, type RefCallback, type RefObject } from "react";
import type { TranscriptMessage } from "./desktop-state";
import type { DisplayTimelineItem } from "./timeline-types";
import { buildDisplayTimelineItems } from "./timeline-turns";
import { ThreadSearchBar } from "./thread-search";
import type { ThreadSearchMatch } from "./hooks/use-thread-search";
import { TimelineItem } from "./timeline-item";
import { SparkIcon } from "./icons";
import { useI18n } from "./i18n/I18nProvider";

const OVERSCAN_PX = 720;
const ROW_GAP_PX = 14;
const SCROLL_TO_PADDING_PX = 16;
export const VIRTUALIZATION_THRESHOLD = 80;
const TIMELINE_SCROLL_KEYS = new Set(["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", " "]);

interface ThreadSearchModel {
  readonly isOpen: boolean;
  readonly query: string;
  readonly matchCount: number;
  readonly activeIndex: number;
  readonly matches: readonly ThreadSearchMatch[];
  readonly matchedQuery: string;
  readonly activeMatch: ThreadSearchMatch | undefined;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly search: (query: string) => void;
  readonly goToMatch: (direction: 1 | -1) => void;
  readonly close: () => void;
}

interface ConversationTimelineProps {
  readonly transcript: readonly TranscriptMessage[];
  readonly isTranscriptLoading: boolean;
  readonly timelinePaneRef: MutableRefObject<HTMLDivElement | null>;
  readonly timelinePaneElementRef?: RefCallback<HTMLDivElement>;
  readonly disableVirtualization?: boolean;
  readonly onDisableVirtualizationReady?: () => void;
  readonly onTimelineScroll: () => void;
  readonly onTimelineScrollIntent?: () => void;
  readonly threadSearch: ThreadSearchModel;
  readonly showJumpToLatest: boolean;
  readonly onJumpToLatest: () => void;
  readonly onContentHeightChange: (state?: { readonly wasAtBottom: boolean }) => void;
  readonly onViewFileInDiff?: (path: string) => void;
  readonly onForkFromMessage?: (messageIndex: number, preview?: string) => void;
  readonly promptRailVisible?: boolean;
}

export function ConversationTimeline({
  transcript,
  isTranscriptLoading,
  timelinePaneRef,
  timelinePaneElementRef,
  disableVirtualization = false,
  onDisableVirtualizationReady,
  onTimelineScroll,
  onTimelineScrollIntent,
  threadSearch,
  showJumpToLatest,
  onJumpToLatest,
  onContentHeightChange,
  onViewFileInDiff,
  onForkFromMessage,
  promptRailVisible = true,
}: ConversationTimelineProps) {
  const { t } = useI18n();
  const renderedMessageIndexById = useMemo(() => {
    const map = new Map<string, number>();
    let messageIndex = 0;
    for (const item of transcript) {
      if (item.kind !== "message") {
        continue;
      }
      map.set(item.id, messageIndex);
      messageIndex += 1;
    }
    return map;
  }, [transcript]);

  const displayItems = useMemo(() => buildDisplayTimelineItems(transcript), [transcript]);

  // Search no longer needs virtualization disabled — matching runs over the full
  // transcript data (use-thread-search.ts), independent of what's mounted, and
  // highlighting/scrolling only need whatever's currently rendered.
  const shouldVirtualize =
    transcript.length > VIRTUALIZATION_THRESHOLD &&
    !disableVirtualization;
  const [expandedToolCallIds, setExpandedToolCallIds] = useState<Set<string>>(() => new Set());
  const measuredHeightsRef = useRef(new Map<string, number>());
  const [measurementVersion, setMeasurementVersion] = useState(0);

  useLayoutEffect(() => {
    const availableToolCallIds = new Set(
      transcript.filter((item): item is Extract<TranscriptMessage, { kind: "tool" }> => item.kind === "tool").map((item) => item.callId),
    );
    setExpandedToolCallIds((current) => {
      if (current.size === 0) {
        return current;
      }
      let changed = false;
      const next = new Set<string>();
      for (const callId of current) {
        if (!availableToolCallIds.has(callId)) {
          changed = true;
          continue;
        }
        next.add(callId);
      }
      return changed ? next : current;
    });
  }, [transcript]);

  useLayoutEffect(() => {
    const knownIds = new Set(transcript.map((item) => item.id));
    let removedAny = false;
    for (const id of measuredHeightsRef.current.keys()) {
      if (knownIds.has(id)) {
        continue;
      }
      measuredHeightsRef.current.delete(id);
      removedAny = true;
    }
    if (removedAny) {
      setMeasurementVersion((current) => current + 1);
    }
  }, [transcript]);

  useLayoutEffect(() => {
    if (!disableVirtualization || isTranscriptLoading || transcript.length === 0) {
      return;
    }
    const allRowsMeasured = transcript.every((item) => measuredHeightsRef.current.has(item.id));
    if (!allRowsMeasured) {
      return;
    }
    onDisableVirtualizationReady?.();
  }, [disableVirtualization, isTranscriptLoading, measurementVersion, onDisableVirtualizationReady, transcript]);

  const toggleToolCall = useCallback((callId: string) => {
    setExpandedToolCallIds((current) => {
      const next = new Set(current);
      if (next.has(callId)) {
        next.delete(callId);
      } else {
        next.add(callId);
      }
      return next;
    });
  }, []);

  const updateMeasuredHeight = useCallback((id: string, height: number) => {
    const nextHeight = Math.max(1, Math.ceil(height));
    const currentHeight = measuredHeightsRef.current.get(id);
    if (currentHeight === nextHeight) {
      return;
    }
    measuredHeightsRef.current.set(id, nextHeight);
    setMeasurementVersion((current) => current + 1);
  }, []);

  const assignTimelinePaneRef = useCallback((node: HTMLDivElement | null) => {
    timelinePaneRef.current = node;
    timelinePaneElementRef?.(node);
  }, [timelinePaneElementRef, timelinePaneRef]);

  const userPrompts = useMemo<readonly UserPromptEntry[]>(() => {
    const prompts: UserPromptEntry[] = [];
    const emptyPromptLabel = t("timeline.prompt");
    let turnNumber = 0;
    for (const item of transcript) {
      if (item.kind !== "message" || item.role !== "user") {
        continue;
      }
      turnNumber += 1;
      prompts.push({ id: item.id, turnNumber, preview: buildPromptPreview(item.text, emptyPromptLabel) });
    }
    return prompts;
  }, [transcript, t]);

  const scrollToMessage = useCallback((messageId: string) => {
    const pane = timelinePaneRef.current;
    if (!pane) {
      return;
    }

    // Mark this as a deliberate scroll so the bottom-pinning engine treats it as
    // intent and does not snap the view back to the latest activity.
    onTimelineScrollIntent?.();

    const scrollToExisting = (): boolean => {
      const target = pane.querySelector<HTMLElement>(`[data-message-id="${cssEscape(messageId)}"]`);
      if (!target) {
        return false;
      }
      const paneRect = pane.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const nextTop = Math.max(0, pane.scrollTop + (targetRect.top - paneRect.top) - SCROLL_TO_PADDING_PX);
      // Jumping from a virtualized region must be synchronous. A smooth
      // animation can be interrupted by the virtualization/layout pass and
      // leave the pane at its previous (often bottom) position.
      pane.scrollTo({ top: nextTop, behavior: "auto" });
      return true;
    };

    if (scrollToExisting()) {
      return;
    }

    // Virtualized rows outside the render window are absent from the DOM, so jump
    // to the computed offset first, then let the row mount and fine-tune.
    let offset = 0;
    for (const item of displayItems) {
      if (item.id === messageId) {
        break;
      }
      offset += measuredHeightsRef.current.get(item.id) ?? estimateTimelineItemHeight(item);
      offset += ROW_GAP_PX;
    }
    pane.scrollTop = Math.max(0, offset - SCROLL_TO_PADDING_PX);
    const fineTune = (remainingFrames: number) => {
      if (scrollToExisting() || remainingFrames <= 0) {
        return;
      }
      window.requestAnimationFrame(() => fineTune(remainingFrames - 1));
    };
    window.requestAnimationFrame(() => fineTune(8));
  }, [displayItems, onTimelineScrollIntent, timelinePaneRef]);

  useLayoutEffect(() => {
    const pane = timelinePaneRef.current;
    if (!pane) {
      return undefined;
    }

    pane.addEventListener("scroll", onTimelineScroll, { passive: true });
    return () => {
      pane.removeEventListener("scroll", onTimelineScroll);
    };
  }, [onTimelineScroll, timelinePaneRef]);

  // Jump to the active search match's row. Matching (use-thread-search.ts) is pure
  // state with no DOM access; this is the one place that turns "which match is
  // active" into an actual scroll, reusing the same virtualization-aware
  // scrollToMessage used for jumping to a specific prompt.
  const lastScrolledSearchMatchRef = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const activeMatch = threadSearch.activeMatch;
    const key = activeMatch ? `${activeMatch.itemId}:${activeMatch.occurrenceIndex}` : undefined;
    if (!key || key === lastScrolledSearchMatchRef.current) {
      return;
    }
    lastScrolledSearchMatchRef.current = key;
    scrollToMessage(activeMatch!.itemId);
  }, [threadSearch.activeMatch, scrollToMessage]);

  // Paints search matches via the CSS Custom Highlight API instead of mutating the
  // DOM (the prior <mark>-insertion approach fought React's own rendering — a
  // streamed delta or a theme-triggered re-render could land mid-mark and corrupt
  // it). Rebuilds whenever the match set changes or the rendered rows themselves
  // change (virtualization scroll, streaming text), since only mounted rows have
  // DOM to build Ranges over.
  useLayoutEffect(() => {
    if (!supportsHighlightApi()) {
      return undefined;
    }
    const pane = timelinePaneRef.current;
    if (!pane) {
      return undefined;
    }
    // Skip installing the observer entirely while search is closed/empty — this
    // effect's own cleanup already clears any stale highlight, and an idle
    // MutationObserver watching the whole pane subtree would otherwise fire on
    // every streaming delta for no benefit.
    if (!threadSearch.matchedQuery.trim() || threadSearch.matches.length === 0) {
      clearSearchHighlights();
      return undefined;
    }

    let scheduled = false;
    const rebuild = (): boolean =>
      applySearchHighlights(pane, threadSearch.matches, threadSearch.matchedQuery, threadSearch.activeMatch);
    const scheduleRebuild = () => {
      if (scheduled) {
        return;
      }
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        rebuild();
      });
    };

    // A jump to a match outside the mounted window (scrollToMessage) sets scrollTop
    // synchronously, then relies on the resulting native `scroll` event to update the
    // virtualization window and mount the target row a few frames later. A
    // MutationObserver alone can race that: if this effect's own deps happen to
    // change again before the mount's mutation record is delivered, tearing down and
    // reinstalling the observer silently discards it (a MutationObserver gotcha —
    // disconnect() drops any pending, undelivered records). Retrying every frame
    // until the active match is actually found (or a generous frame budget runs
    // out) closes that race without depending on delivery timing — bounded and
    // self-terminating, and it stops immediately once the target is found, so the
    // common (already-mounted) case pays for exactly one frame.
    let settleAttemptsRemaining = 60;
    const scheduleSettleRebuild = () => {
      if (settleAttemptsRemaining <= 0) {
        return;
      }
      settleAttemptsRemaining -= 1;
      requestAnimationFrame(() => {
        if (!rebuild()) {
          scheduleSettleRebuild();
        }
      });
    };

    scheduleSettleRebuild();
    const observer = new MutationObserver(scheduleRebuild);
    observer.observe(pane, { childList: true, subtree: true, characterData: true });
    pane.addEventListener("scroll", scheduleRebuild, { passive: true });

    return () => {
      observer.disconnect();
      pane.removeEventListener("scroll", scheduleRebuild);
      clearSearchHighlights();
    };
  }, [threadSearch.matches, threadSearch.matchedQuery, threadSearch.activeMatch, timelinePaneRef]);

  // Register scroll intent for the keys that actually move a focused, scrollable
  // element — without this, keyboard-only scrolling (PageUp/PageDown/Home/End/arrows/
  // Space) looked like unintentional layout drift to the bottom-pinning engine and got
  // snapped back to the bottom mid-scroll.
  const handleTimelinePaneKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (TIMELINE_SCROLL_KEYS.has(event.key)) {
      onTimelineScrollIntent?.();
    }
  }, [onTimelineScrollIntent]);

  return (
    <div className="timeline-surface">
    <div
      className="timeline-pane timeline-pane--thread"
      data-testid="timeline-pane"
      ref={assignTimelinePaneRef}
      tabIndex={0}
      aria-label={t("timeline.paneLabel")}
      onPointerDown={onTimelineScrollIntent}
      onWheel={onTimelineScrollIntent}
      onKeyDown={handleTimelinePaneKeyDown}
    >
      {threadSearch.isOpen ? (
        <ThreadSearchBar
          query={threadSearch.query}
          matchCount={threadSearch.matchCount}
          activeIndex={threadSearch.activeIndex}
          inputRef={threadSearch.inputRef}
          onSearch={threadSearch.search}
          onNext={() => threadSearch.goToMatch(1)}
          onPrev={() => threadSearch.goToMatch(-1)}
          onClose={threadSearch.close}
        />
      ) : null}
      {isTranscriptLoading ? (
        <div className="timeline" data-testid="transcript">
          <TranscriptSkeleton />
        </div>
      ) : transcript.length === 0 ? (
        <div className="timeline" data-testid="transcript">
          <TranscriptEmptyState />
        </div>
      ) : shouldVirtualize ? (
        <VirtualizedTranscriptList
          displayItems={displayItems}
          timelinePaneRef={timelinePaneRef}
          onContentHeightChange={onContentHeightChange}
          measuredHeightsRef={measuredHeightsRef}
          measurementVersion={measurementVersion}
          expandedToolCallIds={expandedToolCallIds}
          onHeightChange={updateMeasuredHeight}
          onToggleToolCall={toggleToolCall}
          onViewFileInDiff={onViewFileInDiff}
          renderedMessageIndexById={renderedMessageIndexById}
          onForkFromMessage={onForkFromMessage}
        />
      ) : (
        <div className="timeline" data-testid="transcript">
          {displayItems.map((item) => (
            <MeasuredTimelineItem
              item={item}
              key={item.id}
              onHeightChange={updateMeasuredHeight}
              expandedToolCallIds={expandedToolCallIds}
              onToggleToolCall={toggleToolCall}
              onViewFileInDiff={onViewFileInDiff}
              sourceMessageIndex={renderedMessageIndexById.get(item.id)}
              onForkFromMessage={onForkFromMessage}
            />
          ))}
        </div>
      )}
      {showJumpToLatest ? (
        <button className="timeline-jump" data-testid="timeline-jump" type="button" onClick={onJumpToLatest}>
          {t("timeline.newActivityBelow")}
        </button>
      ) : null}
    </div>
      {promptRailVisible && !isTranscriptLoading && userPrompts.length > 1 ? (
        <TimelineContextRail prompts={userPrompts} onSelect={scrollToMessage} />
      ) : null}
    </div>
  );
}

interface UserPromptEntry {
  readonly id: string;
  readonly turnNumber: number;
  readonly preview: string;
}

function TimelineContextRail({
  prompts,
  onSelect,
}: {
  readonly prompts: readonly UserPromptEntry[];
  readonly onSelect: (messageId: string) => void;
}) {
  const { t } = useI18n();
  return (
    <nav className="timeline-context-rail" data-testid="timeline-context-rail" aria-label={t("timeline.promptsInThread")}>
      <div className="timeline-context-rail__title">{t("timeline.prompts")}</div>
      <ol className="timeline-context-rail__list">
        {prompts.map((prompt) => (
          <li key={prompt.id}>
            <button
              type="button"
              className="timeline-context-rail__item"
              data-testid="timeline-context-rail-item"
              title={prompt.preview}
              onClick={() => onSelect(prompt.id)}
            >
              <span className="timeline-context-rail__index">{prompt.turnNumber}</span>
              <span className="timeline-context-rail__text">{prompt.preview}</span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function buildPromptPreview(text: string, emptyLabel: string): string {
  const firstLine = text.split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? "";
  return firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine || emptyLabel;
}

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/["\\]/g, "\\$&");
}

function TranscriptSkeleton() {
  const { t } = useI18n();
  return (
    <div className="transcript-skeleton" data-testid="transcript-skeleton" aria-hidden="true">
      <div className="transcript-skeleton__row transcript-skeleton__row--user">
        <span className="skeleton-line" style={{ width: "42%" }} />
      </div>
      <div className="transcript-skeleton__row">
        <span className="skeleton-line" style={{ width: "88%" }} />
        <span className="skeleton-line" style={{ width: "94%" }} />
        <span className="skeleton-line" style={{ width: "66%" }} />
      </div>
      <div className="transcript-skeleton__row transcript-skeleton__row--tool">
        <span className="skeleton-line skeleton-line--tool" style={{ width: "38%" }} />
      </div>
      <div className="transcript-skeleton__row">
        <span className="skeleton-line" style={{ width: "80%" }} />
        <span className="skeleton-line" style={{ width: "72%" }} />
      </div>
      <span className="sr-only">{t("timeline.loadingTranscript")}</span>
    </div>
  );
}

function TranscriptEmptyState() {
  const { t } = useI18n();
  return (
    <div className="transcript-empty" data-testid="transcript-empty">
      <span className="transcript-empty__glyph" aria-hidden="true">
        <SparkIcon />
      </span>
      <p className="transcript-empty__title">{t("timeline.startConversation")}</p>
      <p className="transcript-empty__hint">{t("timeline.startConversationBody")}</p>
    </div>
  );
}

function VirtualizedTranscriptList({
  displayItems,
  timelinePaneRef,
  onContentHeightChange,
  measuredHeightsRef,
  measurementVersion,
  expandedToolCallIds,
  onHeightChange,
  onToggleToolCall,
  onViewFileInDiff,
  renderedMessageIndexById,
  onForkFromMessage,
}: {
  readonly displayItems: readonly DisplayTimelineItem[];
  readonly timelinePaneRef: MutableRefObject<HTMLDivElement | null>;
  readonly onContentHeightChange: (state?: { readonly wasAtBottom: boolean }) => void;
  readonly measuredHeightsRef: MutableRefObject<Map<string, number>>;
  readonly measurementVersion: number;
  readonly expandedToolCallIds: ReadonlySet<string>;
  readonly onHeightChange: (id: string, height: number) => void;
  readonly onToggleToolCall: (callId: string) => void;
  readonly onViewFileInDiff?: (path: string) => void;
  readonly renderedMessageIndexById: ReadonlyMap<string, number>;
  readonly onForkFromMessage?: (messageIndex: number, preview?: string) => void;
}) {
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 0 });
  const previousTotalHeightRef = useRef(0);
  void measurementVersion;

  useLayoutEffect(() => {
    const pane = timelinePaneRef.current;
    if (!pane) {
      return undefined;
    }

    const syncViewport = () => {
      const nextScrollTop = pane.scrollTop;
      const nextHeight = pane.clientHeight;
      setViewport((current) =>
        current.scrollTop === nextScrollTop && current.height === nextHeight
          ? current
          : { scrollTop: nextScrollTop, height: nextHeight },
      );
    };

    syncViewport();
    pane.addEventListener("scroll", syncViewport, { passive: true });
    const resizeObserver = new ResizeObserver(() => {
      syncViewport();
    });
    resizeObserver.observe(pane);

    return () => {
      pane.removeEventListener("scroll", syncViewport);
      resizeObserver.disconnect();
    };
  }, [timelinePaneRef]);

  const rowHeights = displayItems.map((item) => measuredHeightsRef.current.get(item.id) ?? estimateTimelineItemHeight(item));
  const rowOffsets: number[] = [];
  let totalHeight = 0;
  for (const [index, rowHeight] of rowHeights.entries()) {
    rowOffsets[index] = totalHeight;
    totalHeight += rowHeight;
    if (index < rowHeights.length - 1) {
      totalHeight += ROW_GAP_PX;
    }
  }

  useLayoutEffect(() => {
    const previousTotalHeight = previousTotalHeightRef.current;
    if (previousTotalHeight === totalHeight) {
      return;
    }
    previousTotalHeightRef.current = totalHeight;
    const pane = timelinePaneRef.current;
    const wasAtBottom = previousTotalHeight > 0 && pane
      ? previousTotalHeight - pane.scrollTop - pane.clientHeight < 32
      : false;
    onContentHeightChange({ wasAtBottom });
  }, [onContentHeightChange, totalHeight]);

  const startOffset = Math.max(0, viewport.scrollTop - OVERSCAN_PX);
  const endOffset = viewport.scrollTop + viewport.height + OVERSCAN_PX;
  const startIndex = findStartIndex(rowOffsets, rowHeights, startOffset);
  const endIndex = findEndIndex(rowOffsets, endOffset);

  return (
    <div className="timeline timeline--virtualized" data-testid="transcript" style={{ height: `${totalHeight}px` }}>
      {displayItems.slice(startIndex, endIndex).map((item, offsetIndex) => {
        const index = startIndex + offsetIndex;
        return (
          <MeasuredTimelineItem
            item={item}
            key={item.id}
            className="timeline__virtual-row"
            top={rowOffsets[index] ?? 0}
            onHeightChange={onHeightChange}
            expandedToolCallIds={expandedToolCallIds}
            onToggleToolCall={onToggleToolCall}
            onViewFileInDiff={onViewFileInDiff}
            sourceMessageIndex={renderedMessageIndexById.get(item.id)}
            onForkFromMessage={onForkFromMessage}
          />
        );
      })}
    </div>
  );
}

function MeasuredTimelineItem({
  item,
  className,
  top,
  onHeightChange,
  expandedToolCallIds,
  onToggleToolCall,
  onViewFileInDiff,
  sourceMessageIndex,
  onForkFromMessage,
}: {
  readonly item: DisplayTimelineItem;
  readonly className?: string;
  readonly top?: number;
  readonly onHeightChange: (id: string, height: number) => void;
  readonly expandedToolCallIds: ReadonlySet<string>;
  readonly onToggleToolCall: (callId: string) => void;
  readonly onViewFileInDiff?: (path: string) => void;
  readonly sourceMessageIndex?: number;
  readonly onForkFromMessage?: (messageIndex: number, preview?: string) => void;
}) {
  const rowRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const element = rowRef.current;
    if (!element) {
      return undefined;
    }

    const measure = () => {
      onHeightChange(item.id, element.getBoundingClientRect().height);
    };

    measure();
    const resizeObserver = new ResizeObserver(() => {
      measure();
    });
    resizeObserver.observe(element);

    return () => {
      resizeObserver.disconnect();
    };
  }, [item.id, onHeightChange]);

  return (
    <div
      className={className}
      ref={rowRef}
      data-message-id={item.id}
      style={top == null ? undefined : { transform: `translateY(${top}px)` }}
    >
      <TimelineItem
        item={item}
        expandedToolCallIds={expandedToolCallIds}
        onToggleToolCall={onToggleToolCall}
        onViewFileInDiff={onViewFileInDiff}
        sourceMessageIndex={sourceMessageIndex}
        onForkFromMessage={onForkFromMessage}
      />
    </div>
  );
}

function findStartIndex(offsets: readonly number[], heights: readonly number[], targetOffset: number): number {
  let low = 0;
  let high = offsets.length - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const end = (offsets[mid] ?? 0) + (heights[mid] ?? 0);
    if (end < targetOffset) {
      low = mid + 1;
      continue;
    }
    high = mid - 1;
  }

  return Math.max(0, Math.min(offsets.length - 1, low));
}

function findEndIndex(offsets: readonly number[], targetOffset: number): number {
  if (offsets.length === 0) {
    return 0;
  }

  let low = 0;
  let high = offsets.length - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if ((offsets[mid] ?? 0) <= targetOffset) {
      low = mid + 1;
      continue;
    }
    high = mid - 1;
  }

  const lastVisibleIndex = Math.max(0, low);
  return Math.min(offsets.length, Math.max(lastVisibleIndex + 1, 1));
}

function estimateTimelineItemHeight(item: DisplayTimelineItem): number {
  if (item.kind === "turn-marker") {
    return 32;
  }
  if (item.kind === "message") {
    const attachmentHeight = item.attachments?.some((attachment) => attachment.kind === "image")
      ? 120
      : item.attachments?.length
        ? 56
        : 0;
    const textLength = Math.max(item.text.length, 1);
    return 48 + attachmentHeight + Math.min(240, Math.ceil(textLength / 90) * 20);
  }
  if (item.kind === "tool") {
    return 52;
  }
  if (item.kind === "summary") {
    return item.presentation === "divider" ? 44 : 38;
  }
  return 38;
}

/* ── Thread search highlighting (CSS Custom Highlight API) ─────────────────
 * Paints matches without touching the DOM: a Range per occurrence, registered
 * under a named Highlight that ::highlight(thread-find) in timeline.css paints.
 * This can't fight React's own re-renders the way inserting <mark> elements
 * could (a streamed delta or a theme toggle re-rendering mid-mark), since a
 * Range is just a pointer into existing text nodes, not new DOM structure. */

const SEARCH_HIGHLIGHT_NAME = "thread-find";
const SEARCH_ACTIVE_HIGHLIGHT_NAME = "thread-find-active";

function supportsHighlightApi(): boolean {
  return (
    typeof CSS !== "undefined" &&
    typeof CSS.highlights !== "undefined" &&
    typeof Highlight !== "undefined"
  );
}

function clearSearchHighlights(): void {
  if (!supportsHighlightApi()) {
    return;
  }
  CSS.highlights.delete(SEARCH_HIGHLIGHT_NAME);
  CSS.highlights.delete(SEARCH_ACTIVE_HIGHLIGHT_NAME);
}

/** All occurrences of `lowerQuery` in `root`'s rendered text, in document order. */
function findOccurrenceRangesInRow(root: Node, lowerQuery: string): Range[] {
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    const text = node.textContent ?? "";
    const lowerText = text.toLowerCase();
    let fromIndex = 0;
    let foundAt = lowerText.indexOf(lowerQuery, fromIndex);
    while (foundAt !== -1) {
      const range = document.createRange();
      range.setStart(node, foundAt);
      range.setEnd(node, foundAt + lowerQuery.length);
      ranges.push(range);
      fromIndex = foundAt + lowerQuery.length;
      foundAt = lowerText.indexOf(lowerQuery, fromIndex);
    }
  }
  return ranges;
}

/**
 * Rebuilds the two search highlights from whatever rows are currently mounted, and
 * reports whether the *active* match specifically was found — the signal the
 * settle-retry loop above uses to know it can stop. (General matches can be
 * non-empty from already-mounted rows while the just-navigated-to active one still
 * isn't — the row scrollToMessage is mid-jump toward — so activeRanges is the
 * meaningful completion signal, not matchRanges.)
 *
 * Matches are computed against each item's *source* text (use-thread-search.ts),
 * while this walks *rendered* (post-markdown) DOM text — the two agree on order
 * and count for ordinary text, so `activeMatch.occurrenceIndex` (that match's
 * position among same-row matches) reliably picks out the same occurrence in the
 * rendered row. They can only disagree when the matched substring itself contains
 * markdown syntax that rendering strips, in which case the active-highlight pick
 * may be off within a many-match row — matches are still found and navigable
 * (scrollToMessage targets the row itself, not a sub-position) either way.
 */
function applySearchHighlights(
  pane: HTMLElement,
  matches: readonly ThreadSearchMatch[],
  lowerQueryRaw: string,
  activeMatch: ThreadSearchMatch | undefined,
): boolean {
  const lowerQuery = lowerQueryRaw.trim().toLowerCase();
  if (!lowerQuery || matches.length === 0) {
    clearSearchHighlights();
    return true;
  }

  const matchItemIds = new Set(matches.map((match) => match.itemId));
  const matchRanges: Range[] = [];
  const activeRanges: Range[] = [];

  for (const row of pane.querySelectorAll<HTMLElement>("[data-message-id]")) {
    const itemId = row.dataset.messageId;
    if (!itemId || !matchItemIds.has(itemId)) {
      continue;
    }
    const occurrences = findOccurrenceRangesInRow(row, lowerQuery);
    occurrences.forEach((range, occurrenceIndex) => {
      matchRanges.push(range);
      if (activeMatch && activeMatch.itemId === itemId && activeMatch.occurrenceIndex === occurrenceIndex) {
        activeRanges.push(range);
      }
    });
  }

  CSS.highlights.set(SEARCH_HIGHLIGHT_NAME, new Highlight(...matchRanges));
  CSS.highlights.set(SEARCH_ACTIVE_HIGHLIGHT_NAME, new Highlight(...activeRanges));
  return !activeMatch || activeRanges.length > 0;
}
