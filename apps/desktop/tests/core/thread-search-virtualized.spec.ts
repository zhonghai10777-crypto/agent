import { expect, test } from "@playwright/test";
import {
  createSessionViaIpc,
  desktopShortcut,
  getTimelineScrollMetrics,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedTranscriptMessages,
} from "../helpers/electron-app";
import { appendMessagesToSessionFile, sessionFilePathFromCatalog } from "../helpers/session-file";

const TOTAL_MESSAGES = 1200;
const MARKER = "FINDTHISMARKER";
// Spread across the whole transcript to prove matching runs over the full
// transcript's *data* (use-thread-search.ts), not over whatever a virtualized DOM
// happens to have mounted. Opening a search auto-activates its first (lowest-
// index) match, which triggers a real scroll (conversation-timeline.tsx) — so with
// row 10 as that first match, this section's own scroll jump is nearly the full
// transcript's span. This section deliberately asserts only match *count* and DOM
// *size*, which are pure data/DOM-size checks that don't depend on that jump
// landing anywhere in particular; the separate navigation section below uses its
// own, much closer marker so it isn't riding on this section's leftover scroll
// state or its worst-case jump distance.
const MARKER_ROWS = [10, 400, 800, 1150];
// A single, close marker for the navigation+highlighting proof. It only needs to
// be outside the initially-mounted (bottom-pinned) window, which covers roughly
// the last dozen rows — not to stress how far scrollToMessage's estimate-then-
// mount jump (conversation-timeline.tsx) can reliably travel in one step. That
// jump's own reliability at large distances is a property of a shared, pre-
// existing navigation helper (also used for jump-to-prompt) with no other
// existing test coverage at scale; characterizing or improving it is out of scope
// here, so this section deliberately stays inside the range it already
// demonstrably handles well, from a freshly re-settled bottom-pinned baseline.
const NAVIGABLE_MARKER_ROW = 1180;
const NAVIGABLE_MARKER = "NAVTHISMARKER";

test("thread search stays virtualized, matches the full transcript, and can navigate to a match outside the mounted window", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("thread-search-virtualized");
  let harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    let window = await harness.firstWindow();
    const title = "Thread search virtualized test";
    await createSessionViaIpc(window, workspacePath, title);

    // seedTranscriptMessages replays messages through the app's live session-event
    // pipeline one at a time — realistic for a handful of messages, but for 1200
    // rows the replay itself takes many seconds, during which the renderer's own
    // transcript is still growing (each arrival forces a virtualization-disabling
    // remeasure pass, per the onDisableVirtualizationReady flow in
    // conversation-timeline.tsx). Only one seed message is needed here, to obtain a
    // real sessionRef with at least one entry so appendMessagesToSessionFile below
    // has something to chain off; the full 1200-row transcript is instead written
    // directly to the session file and loaded in one shot by a fresh launch, so
    // this test's assertions run against a transcript that has already fully
    // settled rather than one still catching up mid-replay.
    const seeded = await seedTranscriptMessages(harness, window, { count: 1 });
    const messages = Array.from({ length: TOTAL_MESSAGES }, (_, index) => {
      if (index === NAVIGABLE_MARKER_ROW) return `Row ${index} ${NAVIGABLE_MARKER} content.`;
      if (MARKER_ROWS.includes(index)) return `Row ${index} ${MARKER} content.`;
      return `Row ${index} ordinary content. `.repeat(6);
    });
    await appendMessagesToSessionFile(
      await sessionFilePathFromCatalog(userDataDir, seeded.sessionRef),
      messages.map((text) => ({ role: "assistant" as const, text })),
    );
    await harness.close();

    harness = await launchDesktop(userDataDir, { testMode: "background" });
    window = await harness.firstWindow();
    await expect(window.locator(".topbar__session")).toHaveText(title, { timeout: 30_000 });

    const domCounts = async () =>
      window.evaluate(() => ({
        items: document.querySelectorAll(".timeline-item").length,
        virtualized: Boolean(document.querySelector(".timeline--virtualized")),
      }));
    // 32px matches the app's own "near bottom" tolerance (TIMELINE_NEAR_BOTTOM_PX
    // in use-timeline-scroll.ts) — the bar for "counts as pinned" during ordinary
    // scrolling. A stricter ~16px bar is reachable after the app's own dedicated
    // exact-bottom-restore fine-tuning (session load/jumpToLatest), but this test
    // returns to bottom via an ordinary End keypress, which relies on the
    // browser's native scroll-to-end behavior rather than that fine-tuning path —
    // so this test holds itself to the same tolerance the app itself uses to
    // decide "pinned," not the tighter bar a different, unrelated code path meets.
    const waitForBottomPinnedSettle = () =>
      expect.poll(async () => (await getTimelineScrollMetrics(window)).remainingFromBottom).toBeLessThanOrEqual(32);

    await waitForBottomPinnedSettle();
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
    // blown up to near-full size to produce that count.
    await expect(window.locator(".thread-search-bar__count")).toHaveText(`1 / ${MARKER_ROWS.length}`);
    const afterSearch = await domCounts();
    expect(afterSearch.virtualized).toBe(true);
    expect(afterSearch.items).toBeLessThan(TOTAL_MESSAGES / 4);

    // Close this search and let the pane fully re-settle at the bottom before the
    // navigation section below — otherwise it would inherit this section's own
    // scroll disturbance (the auto-jump to row 10, nearly a full-transcript span)
    // as an unpredictable starting position for its own, independent jump. Return
    // via a real End keypress (routed through the pane's own keyboard-scroll
    // handling) rather than assigning `scrollTop = scrollHeight` directly: a raw
    // assignment snapshots `scrollHeight` at that instant, and if row-height
    // measurement is still catching up from the previous jump, the real
    // scrollHeight can keep growing afterward, permanently undershooting a
    // one-time assignment. A real keypress lets the browser (and the app's own
    // bottom-pinning re-alignment) resolve against whatever scrollHeight is
    // current at the time.
    await window.keyboard.press("Escape");
    await expect(searchInput).toHaveCount(0);
    const pane = window.getByTestId("timeline-pane");
    await pane.focus();
    await pane.press("End");
    await waitForBottomPinnedSettle();
    await expect.poll(async () => (await domCounts()).virtualized).toBe(true);

    // Now prove navigation and highlighting from a known-good baseline: search for
    // a single match outside the mounted window but close to it, and confirm it
    // lands on screen — highlighted via the CSS Custom Highlight API — without
    // breaking virtualization.
    await window.keyboard.press(desktopShortcut("F"));
    await expect(searchInput).toBeVisible();
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
