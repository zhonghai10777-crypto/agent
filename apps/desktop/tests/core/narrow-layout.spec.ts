import { expect, test } from "@playwright/test";
import { getDesktopState, launchDesktop, makeUserDataDir, makeWorkspace } from "../helpers/electron-app";

const WIDE_SIZE = { w: 1200, h: 800 } as const;
const NARROW_SIZE = { w: 600, h: 700 } as const;

test("narrow window turns the sidebar into a dismissible drawer without touching the persisted preference", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("narrow-layout-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await expect(window.locator(".sidebar")).toBeVisible();
    const initialState = await getDesktopState(window);
    expect(initialState.sidebarCollapsed).toBe(false);

    await harness.electronApp.evaluate(async ({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0]?.setSize(size.w, size.h);
    }, WIDE_SIZE);

    await harness.electronApp.evaluate(async ({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0]?.setSize(size.w, size.h);
    }, NARROW_SIZE);

    // Entering narrow mode: the drawer defaults closed and the sidebar is unmounted,
    // not just visually hidden — the main content should have the full width.
    await expect(window.locator(".sidebar")).toHaveCount(0);
    await expect(window.getByTestId("sidebar-drawer-backdrop")).toHaveCount(0);

    const toggle = window.getByTestId("sidebar-toggle");
    await toggle.click();
    await expect(window.locator(".sidebar")).toBeVisible();
    const backdrop = window.getByTestId("sidebar-drawer-backdrop");
    await expect(backdrop).toBeVisible();

    // Clicking the backdrop closes the drawer. Click well to the right of the drawer's
    // own width (min(292px, 84vw) in a 600px window) — the drawer sits on top of (and
    // would intercept clicks over) the backdrop's left portion.
    await backdrop.click({ position: { x: 550, y: 100 } });
    await expect(window.locator(".sidebar")).toHaveCount(0);
    await expect(backdrop).toHaveCount(0);

    // Escape also closes it.
    await toggle.click();
    await expect(window.locator(".sidebar")).toBeVisible();
    await window.keyboard.press("Escape");
    await expect(window.locator(".sidebar")).toHaveCount(0);

    // Widening back out restores the normal layout, and the persisted preference was
    // never written to by any of the narrow-mode drawer interactions above.
    await harness.electronApp.evaluate(async ({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0]?.setSize(size.w, size.h);
    }, WIDE_SIZE);
    await expect(window.locator(".sidebar")).toBeVisible();
    const finalState = await getDesktopState(window);
    expect(finalState.sidebarCollapsed).toBe(false);
  } finally {
    await harness.close();
  }
});
