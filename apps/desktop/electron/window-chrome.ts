import type { BrowserWindowConstructorOptions, TitleBarOverlay } from "electron";
import { usesWindowControlsOverlay } from "../src/ipc";

export type ResolvedTheme = "light" | "dark";

/** Height of the renderer's `.topbar`; the caption buttons fill it exactly. */
export const TITLEBAR_HEIGHT = 45;

/** The renderer's `--text` in each theme, so the caption symbols read like the topbar icons. */
const CAPTION_SYMBOL_COLORS: Readonly<Record<ResolvedTheme, string>> = {
  light: "#39435b",
  dark: "#d4d4d8",
};

export function windowControlsOverlay(theme: ResolvedTheme): TitleBarOverlay {
  // Transparent, so whatever the view paints beneath (topbar, settings page)
  // shows through in every theme and preset; only the symbols need a color.
  return { color: "#00000000", symbolColor: CAPTION_SYMBOL_COLORS[theme], height: TITLEBAR_HEIGHT };
}

/**
 * `hiddenInset` exists only on macOS. Any hidden title bar on Windows or Linux
 * drops the native frame, so without the overlay the window there had no
 * minimize, maximize or close button at all.
 */
export function windowChromeOptions(
  platform: NodeJS.Platform,
  theme: ResolvedTheme,
): Pick<BrowserWindowConstructorOptions, "titleBarStyle" | "titleBarOverlay" | "trafficLightPosition"> {
  if (!usesWindowControlsOverlay(platform)) {
    return { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 18, y: 18 } };
  }
  return { titleBarStyle: "hidden", titleBarOverlay: windowControlsOverlay(theme) };
}
