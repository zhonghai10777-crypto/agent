import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { PRODUCT } from "../../src/product";

test("the Windows AppUserModelID set at startup is the appId the installer's shortcut registers", async () => {
  // A mismatch silently drops every Windows notification.
  const builderConfig = await readFile(join(__dirname, "..", "..", "electron-builder.yml"), "utf8");
  expect(/^appId:\s*(\S+)\s*$/m.exec(builderConfig)?.[1]).toBe(PRODUCT.appId);
});
