import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import {
  DEFAULT_LIBRARY_SETTINGS,
  LibraryStore,
  normalizeLibrarySettings,
} from "../../electron/library-store";

test("normalizeLibrarySettings accepts only unique absolute directory paths", () => {
  const absolute = resolve("/tmp", "plant-library");
  expect(
    normalizeLibrarySettings({
      enabled: "yes",
      roots: [absolute, ` ${absolute} `, "relative/path", 42],
    }),
  ).toEqual({ enabled: false, roots: [absolute] });

  expect(normalizeLibrarySettings(null)).toEqual(DEFAULT_LIBRARY_SETTINGS);
  expect(normalizeLibrarySettings({ enabled: true, roots: "not-an-array" })).toEqual({
    enabled: true,
    roots: [],
  });
});

test("LibraryStore persists normalized settings and serves subsequent reads from memory", async ({}, testInfo) => {
  const root = testInfo.outputPath("library-store");
  await mkdir(root, { recursive: true });
  const filePath = join(root, "library.json");
  const libraryRoot = resolve(root, "documents");
  const store = new LibraryStore(filePath);

  expect(store.write({ enabled: true, roots: [libraryRoot, "relative"] })).toEqual({
    enabled: true,
    roots: [libraryRoot],
  });
  expect(store.read()).toEqual({ enabled: true, roots: [libraryRoot] });

  await writeFile(filePath, "not json", "utf8");
  expect(store.read()).toEqual({ enabled: true, roots: [libraryRoot] });
  expect(new LibraryStore(filePath).read()).toEqual(DEFAULT_LIBRARY_SETTINGS);
});
