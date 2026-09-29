import { nativeTheme, type BrowserWindow } from "electron";
import { desktopIpc, usesWindowControlsOverlay } from "../src/ipc";
import type { ThemeMode } from "../src/desktop-state";
import { windowControlsOverlay } from "./window-chrome";

export class ThemeManager {
  private mode: ThemeMode = "system";
  private readonly windows = new Set<BrowserWindow>();

  constructor() {
    nativeTheme.on("updated", () => {
      this.broadcast();
    });
  }

  trackWindow(win: BrowserWindow) {
    if (win.isDestroyed() || this.windows.has(win)) {
      return;
    }
    this.windows.add(win);
    win.once("closed", () => {
      this.windows.delete(win);
    });
  }

  getMode(): ThemeMode {
    return this.mode;
  }

  getResolvedTheme(): "light" | "dark" {
    if (this.mode === "system") {
      return nativeTheme.shouldUseDarkColors ? "dark" : "light";
    }
    return this.mode;
  }

  setMode(mode: ThemeMode) {
    this.mode = mode;
    if (mode === "system") {
      nativeTheme.themeSource = "system";
    } else {
      nativeTheme.themeSource = mode;
    }
    this.broadcast();
  }

  private broadcast() {
    const theme = this.getResolvedTheme();
    for (const window of this.windows) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send(desktopIpc.themeChanged, theme);
        if (usesWindowControlsOverlay(process.platform)) {
          // The caption buttons are native, so they do not follow the page's CSS.
          window.setTitleBarOverlay(windowControlsOverlay(theme));
        }
      }
    }
  }
}
