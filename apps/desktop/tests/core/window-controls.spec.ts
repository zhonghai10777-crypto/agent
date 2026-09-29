import { expect, test, type Page } from "@playwright/test";
import { TITLEBAR_HEIGHT } from "../../electron/window-chrome";
import {
  createNamedThread,
  launchDesktop,
  makeGitWorkspace,
  makeUserDataDir,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

/** Windows 11's three caption buttons at 100% scaling. */
const CAPTION_BUTTONS_WIDTH = 138;

/**
 * The Window Controls Overlay only exists on Windows and Linux, so stand in for
 * it: the renderer's overlay mode, with the geometry its env variables would give.
 */
async function simulateCaptionButtons(window: Page): Promise<void> {
  await window.evaluate(
    ({ width, height }) => {
      const root = document.documentElement;
      root.dataset.windowControls = "overlay";
      root.style.setProperty("--window-controls-inset", `${width}px`);
      root.style.setProperty("--window-controls-height", `${height}px`);
    },
    { width: CAPTION_BUTTONS_WIDTH, height: TITLEBAR_HEIGHT },
  );
}

/** Visible controls a user could not reach because the caption buttons cover them. */
async function controlsUnderCaptionButtons(window: Page): Promise<string[]> {
  return window.evaluate(
    ({ width, height }) => {
      const left = window.innerWidth - width;
      const selector = "button, a[href], input, select, textarea, [role=button], [role=tab], [tabindex]:not([tabindex='-1'])";
      return [...document.querySelectorAll<HTMLElement>(selector)]
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && rect.right > left && rect.top < height;
        })
        .map((element) => element.getAttribute("aria-label") || element.textContent?.trim() || element.tagName);
    },
    { width: CAPTION_BUTTONS_WIDTH, height: TITLEBAR_HEIGHT },
  );
}

/** Settings, Skills and Extensions replace the whole shell, topbar included. */
async function checkSecondarySurfaces(window: Page): Promise<void> {
  for (const [view, ready] of [
    ["Settings", ".view-header"],
    // Their workspace picker is right-aligned at the top of the page.
    ["Skills", ".surface-toolbar select"],
    ["Extensions", ".surface-toolbar select"],
  ] as const) {
    await window.getByRole("button", { name: view, exact: true }).click();
    await expect(window.locator(ready).first()).toBeVisible();
    expect(await controlsUnderCaptionButtons(window)).toEqual([]);
    await window.getByRole("button", { name: "Back to app" }).click();
    await expect(window.getByTestId("topbar")).toBeVisible();
  }
}

test("keeps every view's controls clear of the Windows caption buttons", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeGitWorkspace("window-controls");
  const harness = await launchDesktop(userDataDir, { initialWorkspaces: [workspacePath], testMode: "background" });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await createNamedThread(window, "Caption buttons thread");
    // The renderer turns overlay mode on by itself exactly where the overlay exists.
    expect(await window.evaluate(() => document.documentElement.dataset.windowControls)).toBe(
      process.platform === "darwin" ? undefined : "overlay",
    );
    // The overlay is sized to the topbar so the buttons line up with it.
    expect((await window.locator(".topbar").boundingBox())?.height).toBe(TITLEBAR_HEIGHT);

    await simulateCaptionButtons(window);
    expect(await controlsUnderCaptionButtons(window)).toEqual([]);
    // Without traffic lights at the top-left, the sidebar toggle moves into the corner.
    expect((await window.getByTestId("sidebar-toggle").boundingBox())?.x).toBe(16);

    await window.getByRole("button", { name: "Toggle changes" }).click();
    expect(await controlsUnderCaptionButtons(window)).toEqual([]);
    await window.getByRole("button", { name: "Toggle changes" }).click();

    await window.getByTestId("sidebar-toggle").click();
    await expect(window.locator(".sidebar")).toHaveCount(0);
    expect(await controlsUnderCaptionButtons(window)).toEqual([]);
    await window.getByTestId("sidebar-toggle").click();

    await window.getByRole("complementary").getByRole("button", { name: "New thread" }).click();
    await expect(window.getByTestId("new-thread-composer")).toBeVisible();
    expect(await controlsUnderCaptionButtons(window)).toEqual([]);

    await checkSecondarySurfaces(window);

    // The narrow layout stacks the topbar and squeezes the pages' toolbars.
    await harness.electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(600, 700);
    });
    await expect(window.locator(".sidebar")).toHaveCount(0);
    expect(await controlsUnderCaptionButtons(window)).toEqual([]);
    await window.getByTestId("sidebar-toggle").click();
    await checkSecondarySurfaces(window);
  } finally {
    await harness.close();
  }
});
