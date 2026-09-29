import type { MenuItemConstructorOptions } from "electron";

/**
 * The application menu on Windows and Linux. The window is frameless there, so
 * no menu bar shows and only the accelerators matter. Without a menu of its own
 * the app got Electron's default one, whose Ctrl+W closed the window (and with
 * the last window the app and every running task), Ctrl+R reloaded the
 * interface, and Ctrl+Shift+I opened DevTools in release builds. Zoom stays;
 * reload and DevTools only in development.
 */
export function nonMacApplicationMenu(isPackaged: boolean): MenuItemConstructorOptions[] {
  const developmentItems: MenuItemConstructorOptions[] = isPackaged
    ? []
    : [{ type: "separator" }, { role: "reload" }, { role: "toggleDevTools" }];
  return [
    {
      label: "View",
      submenu: [{ role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, ...developmentItems],
    },
  ];
}
