import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { moveDirectoryIfAbsent, resolveLocalDataDir } from "../../electron/local-data-dir";

const windowsEnv = { APPDATA: "C:\\Users\\张三\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\张三\\AppData\\Local" };

test("bulky data leaves the Windows roaming profile for the local one", () => {
  expect(resolveLocalDataDir("C:\\Users\\张三\\AppData\\Roaming\\Agent", windowsEnv, path.win32)).toBe(
    "C:\\Users\\张三\\AppData\\Local\\Agent",
  );
  // An explicit profile directory outside the roaming profile keeps its data.
  expect(resolveLocalDataDir("D:\\profiles\\agent", windowsEnv, path.win32)).toBe("D:\\profiles\\agent");
  // macOS and Linux have no roaming profile to leave.
  expect(resolveLocalDataDir("/Users/me/Library/Application Support/Agent", {})).toBe(
    "/Users/me/Library/Application Support/Agent",
  );
});

test("an existing directory moves once and never overwrites the new home", async ({}, info) => {
  const from = info.outputPath("roaming", "library-index");
  const to = info.outputPath("local", "library-index");
  await mkdir(from, { recursive: true });
  await writeFile(path.join(from, "index.json"), "old");

  await moveDirectoryIfAbsent(from, to);
  expect(await readFile(path.join(to, "index.json"), "utf8")).toBe("old");

  await mkdir(from, { recursive: true });
  await writeFile(path.join(from, "index.json"), "stale");
  await moveDirectoryIfAbsent(from, to);
  expect(await readFile(path.join(to, "index.json"), "utf8")).toBe("old");
});
