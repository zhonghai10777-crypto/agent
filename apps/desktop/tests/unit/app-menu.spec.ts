import { expect, test } from "@playwright/test";
import type { MenuItemConstructorOptions } from "electron";
import { nonMacApplicationMenu } from "../../electron/app-menu";

function roles(template: readonly MenuItemConstructorOptions[]): string[] {
  return template.flatMap((item) => [
    ...(item.role ? [item.role] : []),
    ...(Array.isArray(item.submenu) ? roles(item.submenu) : []),
  ]);
}

test("release builds on Windows and Linux keep zoom but no close, reload or DevTools shortcuts", () => {
  // Electron's default menu, installed when an app sets none, carried all three.
  expect(roles(nonMacApplicationMenu(true))).toEqual(["resetZoom", "zoomIn", "zoomOut"]);
});

test("development builds add reload and DevTools", () => {
  expect(roles(nonMacApplicationMenu(false))).toEqual(["resetZoom", "zoomIn", "zoomOut", "reload", "toggleDevTools"]);
});
