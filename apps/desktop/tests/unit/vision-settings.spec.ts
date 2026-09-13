import { expect, test } from "@playwright/test";
import { JsonFileStore } from "../../electron/json-file-store";
import { readMigratedVisionSettings } from "../../electron/vision-settings";
import { DEFAULT_VISION_ROUTING_SETTINGS } from "@pi-gui/session-driver/vision-types";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

test("legacy vision defaults migrate once while the user's disabled switch and historical evidence remain intact", async ({}, info) => {
  const dir = info.outputPath("settings");
  const store = new JsonFileStore<unknown>(dir, "vision-settings");
  const evidence = new JsonFileStore<unknown>(dir, "vision-records");
  const historical = { modelId: "deepseek-v4-flash-vision-exp", usage: { inputTokens: 42 } };
  await evidence.write("historical", historical);
  await store.write("settings", { ...DEFAULT_VISION_ROUTING_SETTINGS, targetModelId: "deepseek-v4-flash-vision-exp", enabled: false });
  expect(await readMigratedVisionSettings(store)).toEqual({ ...DEFAULT_VISION_ROUTING_SETTINGS, enabled: false });
  expect(await store.read("settings")).toMatchObject({ targetModelId: "deepseek-flash", enabled: false });
  const file = (await readdir(join(dir, "vision-settings"))).find((name) => name.endsWith(".json"))!;
  const path = join(dir, "vision-settings", file);
  const before = (await stat(path)).mtimeMs;
  await readMigratedVisionSettings(store);
  expect((await stat(path)).mtimeMs).toBe(before);
  expect(await readFile(`${path}.bak`, "utf8")).toContain("deepseek-v4-flash-vision-exp");
  expect(await evidence.read("historical")).toEqual(historical);
});

test("a locked settings file retains the disabled choice and retries migration when writing is available", async () => {
  let saved: unknown = { enabled: false, targetModelId: "deepseek-v4-flash-vision-exp" };
  const original = saved;
  let locked = true;
  const store = { read: async () => saved, write: async (_key: string, data: unknown) => {
    if (locked) throw new Error("synthetic EACCES");
    saved = data;
  } };
  expect((await readMigratedVisionSettings(store)).enabled).toBe(false);
  expect(saved).toBe(original);
  locked = false;
  await readMigratedVisionSettings(store);
  expect(saved).toMatchObject({ enabled: false, targetModelId: "deepseek-flash" });
});
