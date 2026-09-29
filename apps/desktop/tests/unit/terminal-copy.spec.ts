import { expect, test } from "@playwright/test";
import { isTerminalCopyShortcut } from "../../src/terminal-model";

const key = (chord: Partial<Record<"ctrlKey" | "shiftKey" | "altKey" | "metaKey", boolean>>, name = "c") => ({
  key: name,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...chord,
});

test("off macOS Ctrl+C copies a selection and otherwise still interrupts", () => {
  for (const platform of ["win32", "linux"] as const) {
    expect(isTerminalCopyShortcut(platform, key({ ctrlKey: true }), true)).toBe(true);
    // No selection: the shell must still get ^C.
    expect(isTerminalCopyShortcut(platform, key({ ctrlKey: true }), false)).toBe(false);
    // Ctrl+Shift+C only ever copies (and never interrupts), selection or not.
    expect(isTerminalCopyShortcut(platform, key({ ctrlKey: true, shiftKey: true }, "C"), false)).toBe(true);
    // AltGr arrives as Ctrl+Alt on some layouts and must keep typing.
    expect(isTerminalCopyShortcut(platform, key({ ctrlKey: true, altKey: true }), true)).toBe(false);
    expect(isTerminalCopyShortcut(platform, key({ ctrlKey: true }, "v"), true)).toBe(false);
  }
});

test("macOS keeps Ctrl+C as the interrupt; Cmd+C copies natively", () => {
  expect(isTerminalCopyShortcut("darwin", key({ ctrlKey: true }), true)).toBe(false);
  expect(isTerminalCopyShortcut("darwin", key({ metaKey: true }), true)).toBe(false);
});
