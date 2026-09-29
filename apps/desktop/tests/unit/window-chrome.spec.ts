import { expect, test } from "@playwright/test";
import { TITLEBAR_HEIGHT, windowChromeOptions, windowControlsOverlay } from "../../electron/window-chrome";
import { supportsWindowTransparency } from "../../src/ipc";

test("macOS keeps its inset traffic lights and no overlay", () => {
  expect(windowChromeOptions("darwin", "light")).toEqual({
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 18 },
  });
});

test("Windows and Linux get native caption buttons through a Window Controls Overlay", () => {
  for (const platform of ["win32", "linux"] as const) {
    // `hiddenInset` alone leaves these platforms frameless with no buttons at all.
    const options = windowChromeOptions(platform, "light");
    expect(options.titleBarStyle).toBe("hidden");
    expect(options.titleBarOverlay).toEqual({ color: "#00000000", symbolColor: "#39435b", height: TITLEBAR_HEIGHT });
    expect(options).not.toHaveProperty("trafficLightPosition");
  }
});

test("caption symbols follow the resolved theme over a transparent background", () => {
  expect(windowControlsOverlay("dark")).toEqual({ color: "#00000000", symbolColor: "#d4d4d8", height: TITLEBAR_HEIGHT });
});

test("window transparency is offered only where vibrancy backs it", () => {
  expect(supportsWindowTransparency("darwin")).toBe(true);
  // Without vibrancy a transparent window shows the desktop straight through the text.
  expect(supportsWindowTransparency("win32")).toBe(false);
  expect(supportsWindowTransparency("linux")).toBe(false);
});
