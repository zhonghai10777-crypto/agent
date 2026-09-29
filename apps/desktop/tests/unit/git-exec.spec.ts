import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { applyWindowsGitEnv } from "../../electron/git-exec";

test("every git the app starts on Windows lifts the path length limit, after the user's own env config", () => {
  const env: NodeJS.ProcessEnv = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "Me" };
  applyWindowsGitEnv(env, "win32");
  expect(env).toEqual({
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "user.name",
    GIT_CONFIG_VALUE_0: "Me",
    GIT_CONFIG_KEY_1: "core.longpaths",
    GIT_CONFIG_VALUE_1: "true",
  });

  const untouched: NodeJS.ProcessEnv = {};
  applyWindowsGitEnv(untouched, "darwin");
  expect(untouched).toEqual({});
});

test("git reads the setting from the environment", () => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.GIT_CONFIG_COUNT;
  applyWindowsGitEnv(env, "win32");
  expect(execFileSync("git", ["config", "--get", "core.longpaths"], { env, encoding: "utf8" }).trim()).toBe("true");
});
