import { expect, test } from "@playwright/test";
import { resolveProductUserDataDir } from "../../electron/user-data-dir";

test("prefers an explicit test or portable data directory", () => {
  expect(resolveProductUserDataDir("  C:\\AgentData  ", "C:\\New", "C:\\Legacy", () => true)).toBe(
    "C:\\AgentData",
  );
});

test("reuses legacy desktop data only for an existing upgrade", () => {
  const exists = (filePath: string) => filePath === "C:\\Legacy";
  expect(resolveProductUserDataDir(undefined, "C:\\New", "C:\\Legacy", exists)).toBe("C:\\Legacy");
  expect(resolveProductUserDataDir(undefined, "C:\\New", "C:\\Missing", exists)).toBe("C:\\New");
});

test("keeps the new product directory once it exists", () => {
  expect(resolveProductUserDataDir(undefined, "C:\\New", "C:\\Legacy", () => true)).toBe("C:\\New");
});
