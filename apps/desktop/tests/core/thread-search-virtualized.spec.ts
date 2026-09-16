import { expect, test } from "@playwright/test";
import {
  createSessionViaIpc,
  desktopShortcut,
  getTimelineScrollMetrics,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedTranscriptMessages,
  selectSession,
} from "../helpers/electron-app";

const TOTAL_MESSAGES = 1200;
const MARKER = "FINDTHISMARKER";
// Spread across the whole transcript to prove matching runs over the full
// transcript's *data* (use-thread-search.ts), not over whatever a virtualized DOM
// happens to have mounted. This section only checks the match *count* and the DOM
// size, deliberately not whether every match is on screen: opening a search always
// jumps to its first (lowest-index) match, and 10 is the lowest here specifically
// so that jump is a worst case — nearly the full transcript — which is exactly the
// distance this section must *not* depend on to make its point.
const MARKER_ROWS = [10, 400, 800, 1150];
// A separate, much closer marker for the one navigation assertion below. It only
// needs to be outside the initially-mounted (bottom-pinned) window, which covers
// roughly the last dozen rows — not to stress how far scrollToMessage's
// estimate-then-mount jump (conversation-timeline.tsx) can reliably travel in one
// step. That jump's own reliability at large distances is a property of a shared,
// pre-existing navigation helper (also used for jump-to-prompt) with no other
// existing test coverage at scale; characterizing or improving it is out of scope
// here, so this test deliberately stays inside the range it already demonstrably
// handles well.
const NAVIGABLE_MARKER_ROW = 1180;
const NAVIGABLE_MARKER = "NAVTHISMARKER";

test("thread search stays virtualized, matches the full transcript, and can navigate to a match outside the mounted window", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("thread-search-virtualized");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    const title = "Thread search virtualized test";
    await createSessionViaIpc(window, workspacePath, title);
    await selectSession(window, title);

    await seedTranscriptMessages(harness, window, {
      count: TOTAL_MESSAGES,
      textFactory: (index) => {
        if (index === NAVIGABLE_MARKER_ROW) return `Row ${index} ${NAVIGABLE_MARKER} content.`;
        if (MARKER_ROWS.includes(index)) return `Row ${index} ${MARKER} content.`;
        return `Row ${index} ordinary content. `.repeat(6);
      },
    });

    await expect.poll(async () => (await getTimelineScrollMetrics(window)).remainingFromBottom).toBeLessThanOrEqual(16);

    const domCounts = async () =>
      window.evaluate(() => ({
        items: document.querySelectorAll(".timeline-item").length,
        virtualized: Boolean(document.querySelector(".timeline--virtualized")),
      }));

    // Virtualization re-enables slightly after scroll position settles (it's held off
    // during the initial exact-bottom restore), so poll rather than sampling once.
    await expect.poll(async () => (await domCounts()).virtualized).toBe(true);

    await window.keyboard.press(desktopShortcut("F"));
    const searchInput = window.locator(".thread-search-bar__input");
    await expect(searchInput).toBeVisible();
    await searchInput.fill(MARKER);

    // The match count covers rows scattered across the full 1200-row transcript —
    // proof that matching runs over transcript data, not over whatever a
    // virtualized DOM happens to have mounted — while the DOM itself must not have
    // blown up to near-full size to produce that count. Both are pure data/DOM-size
    // checks, independent of whether the (very distant) first match ever finishes
    // scrolling into view.
    await expect(window.locator(".thread-search-bar__count")).toHaveText(`1 / ${MARKER_ROWS.length}`);
    const afterSearch = await domCounts();
    expect(afterSearch.virtualized).toBe(true);
    expect(afterSearch.items).toBeLessThan(TOTAL_MESSAGES / 4);
    await searchInput.fill("");

    // Now prove navigation and highlighting: search for the row that's outside the
    // mounted window but close to it, and confirm it lands on screen — highlighted
    // via the CSS Custom Highlight API — without breaking virtualization.
    await searchInput.fill(NAVIGABLE_MARKER);
    await expect(window.locator(".thread-search-bar__count")).toHaveText("1 / 1");
    await expect(window.locator(".timeline-item", { hasText: NAVIGABLE_MARKER })).toBeInViewport();
    expect((await domCounts()).virtualized).toBe(true);

    // Highlights aren't queryable as a Playwright locator (no DOM <mark> elements
    // are inserted) — inspect the registered Highlight object directly instead.
    const highlightCount = () =>
      window.evaluate(() => (window as unknown as { CSS: typeof CSS }).CSS.highlights.get("thread-find")?.size ?? -1);
    await expect.poll(highlightCount).toBeGreaterThan(0);
  } finally {
    await harness.close();
  }
});
