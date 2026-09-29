import { expect, test } from "@playwright/test";
import { terminalClipboardShortcut } from "../../src/terminal-model";

const key = (chord: Partial<Record<"ctrlKey" | "shiftKey" | "altKey" | "metaKey", boolean>>, name = "c") => ({
  key: name,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...chord,
});

test("off macOS Ctrl+C copies a selection and otherwise still interrupts; Ctrl+V pastes", () => {
  for (const platform of ["win32", "linux"] as const) {
    expect(terminalClipboardShortcut(platform, key({ ctrlKey: true }), true)).toBe("copy");
    // No selection: the shell must still get ^C.
    expect(terminalClipboardShortcut(platform, key({ ctrlKey: true }), false)).toBeUndefined();
    // Ctrl+Shift+C only ever copies (and never interrupts), selection or not.
    expect(terminalClipboardShortcut(platform, key({ ctrlKey: true, shiftKey: true }, "C"), false)).toBe("copy");
    expect(terminalClipboardShortcut(platform, key({ ctrlKey: true }, "v"), false)).toBe("paste");
    expect(terminalClipboardShortcut(platform, key({ ctrlKey: true, shiftKey: true }, "V"), false)).toBe("paste");
    // AltGr arrives as Ctrl+Alt on some layouts and must keep typing.
    expect(terminalClipboardShortcut(platform, key({ ctrlKey: true, altKey: true }), true)).toBeUndefined();
    expect(terminalClipboardShortcut(platform, key({ ctrlKey: true, altKey: true }, "v"), true)).toBeUndefined();
  }
});

test("macOS leaves Ctrl+C and Ctrl+V to the shell; Cmd copies and pastes natively", () => {
  expect(terminalClipboardShortcut("darwin", key({ ctrlKey: true }), true)).toBeUndefined();
  expect(terminalClipboardShortcut("darwin", key({ ctrlKey: true }, "v"), true)).toBeUndefined();
  expect(terminalClipboardShortcut("darwin", key({ metaKey: true }), true)).toBeUndefined();
});
