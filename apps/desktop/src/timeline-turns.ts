import type { DisplayTimelineItem, TranscriptMessage } from "./timeline-types";

const MIN_WORKED_DURATION_MS = 1_000;

/**
 * Insert "Worked for Ns" turn markers between turns, derived purely from real
 * message/tool timestamps. A turn begins at a user message and runs until the
 * next user message; the marker sits right after the prompt (Codex-style) and
 * reports the elapsed time from the prompt to the last item of that turn.
 *
 * Durations are never fabricated: a marker is emitted only when the turn has
 * downstream work and both endpoints carry parseable timestamps spanning at
 * least one second.
 */
export function buildDisplayTimelineItems(transcript: readonly TranscriptMessage[]): readonly DisplayTimelineItem[] {
  const result: DisplayTimelineItem[] = [];

  for (let index = 0; index < transcript.length; index += 1) {
    const item = transcript[index];
    if (!item) {
      continue;
    }
    result.push(item);

    if (item.kind !== "message" || item.role !== "user") {
      continue;
    }

    const startMs = Date.parse(item.createdAt);
    if (Number.isNaN(startMs)) {
      continue;
    }

    let endMs: number | null = null;
    for (let next = index + 1; next < transcript.length; next += 1) {
      const nextItem = transcript[next];
      if (!nextItem) {
        continue;
      }
      if (nextItem.kind === "message" && nextItem.role === "user") {
        break;
      }
      const nextMs = Date.parse(nextItem.createdAt);
      if (!Number.isNaN(nextMs)) {
        endMs = endMs == null ? nextMs : Math.max(endMs, nextMs);
      }
    }

    if (endMs == null) {
      continue;
    }

    const durationMs = endMs - startMs;
    if (durationMs < MIN_WORKED_DURATION_MS) {
      continue;
    }

    result.push({ kind: "turn-marker", id: `turn-marker:${item.id}`, durationMs });
  }

  return result;
}

/**
 * The text thread search matches against for one timeline item — the single source
 * of truth for "what does this row's content mean for search", shared by the match
 * computation and (indirectly, via the same field list) what TimelineItem renders.
 * This is the item's *source* text, not its rendered form: message text is matched
 * before markdown is applied, so e.g. `**bold**` markers participate in a match.
 * Turn markers carry no user/agent content and are never matches.
 */
export function searchableTextForTimelineItem(item: DisplayTimelineItem): string {
  switch (item.kind) {
    case "message":
      return item.text;
    case "tool":
    case "activity":
      return [item.label, item.detail, item.metadata].filter(Boolean).join(" ");
    case "summary":
      return [item.label, item.metadata].filter(Boolean).join(" ");
    case "turn-marker":
      return "";
    default:
      return "";
  }
}
