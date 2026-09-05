import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBashToolDefinition, createPowerShellToolDefinition, getPowerShellConfig } from "@earendil-works/pi-coding-agent";
import { resetGitBashDetectionCache, type GitBashProbe } from "../dist/windows-git-bash.js";
import { LIGHT_MODE_EXCLUDED_TOOLS, sessionToolNames } from "../dist/windows-shell.js";

const realPlatform = process.platform;
const onWindows = realPlatform === "win32";

/** A probe that finds no Git Bash anywhere, forcing the PowerShell fallback. */
const noGitBashProbe: GitBashProbe = { registryInstallPaths: () => [], gitExecutableFromPath: () => undefined };

/** A probe that reports a fixture install root containing a real `bin\bash.exe`. */
function gitBashProbe(): GitBashProbe {
  const root = mkdtempSync(join(tmpdir(), "git-bash-fixture-"));
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(root, "bin", "bash.exe"), "");
  return { registryInstallPaths: () => [root], gitExecutableFromPath: () => undefined };
}

/** `sessionToolNames` branches on `process.platform`, so both branches are reachable from any host. */
function withPlatform(platform: string, run: () => void): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    run();
  } finally {
    Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
  }
}

test("Windows sessions fall back to pi's powershell tool when no Git Bash exists", () => {
  withPlatform("win32", () => {
    resetGitBashDetectionCache();
    const names = sessionToolNames(noGitBashProbe);
    assert.deepEqual(names, ["read", "powershell", "edit", "write"]);
    assert.ok(!names?.includes("bash"), "without Git Bash a session must not activate the POSIX-only bash tool");
  });
});

test("Windows sessions keep pi's own defaults (bash tool) when Git Bash exists", () => {
  withPlatform("win32", () => {
    resetGitBashDetectionCache();
    assert.equal(sessionToolNames(gitBashProbe()), undefined, "pi's default tool set already contains bash");
  });
});

test("light mode stays command-free whichever shell the platform activates", () => {
  // Light mode used to exclude only "bash". Activating "powershell" on Windows
  // would have silently handed light-mode sessions command execution.
  for (const excluded of ["bash", "powershell", "edit", "write"]) {
    assert.ok(LIGHT_MODE_EXCLUDED_TOOLS.includes(excluded), `light mode must exclude ${excluded}`);
  }

  withPlatform("win32", () => {
    for (const probe of [noGitBashProbe, gitBashProbe()]) {
      resetGitBashDetectionCache();
      const active = (sessionToolNames(probe) ?? ["read", "bash", "edit", "write"]).filter(
        (name) => !LIGHT_MODE_EXCLUDED_TOOLS.includes(name),
      );
      assert.deepEqual(active, ["read"], "light mode on Windows must leave read as the only built-in tool");
    }
  });
});

test("every tool name we activate is one pi registers", { skip: !onWindows }, () => {
  // Guards against pi renaming a tool: the string above would then silently
  // activate nothing, leaving Windows sessions with no shell at all.
  resetGitBashDetectionCache();
  const powershellNames = sessionToolNames(noGitBashProbe);
  assert.equal(createPowerShellToolDefinition(process.cwd()).name, "powershell");
  assert.ok(powershellNames?.includes("powershell"));

  resetGitBashDetectionCache();
  assert.equal(sessionToolNames(gitBashProbe()), undefined);
  assert.equal(createBashToolDefinition(process.cwd()).name, "bash");
});

test("the PowerShell fallback is discoverable without Git or WSL installed", { skip: !onWindows }, () => {
  // The point of the fallback: this must hold on a stock Windows machine, where
  // pi's bash tool has no shell to resolve.
  const config = getPowerShellConfig();
  assert.ok(existsSync(config.shell), `resolved PowerShell should exist on disk: ${config.shell}`);
  assert.ok(/(?:pwsh|powershell)\.exe$/iu.test(config.shell), `unexpected shell: ${config.shell}`);
  assert.equal(config.args.at(-1), "-Command", "the command must be passed via -Command");
  assert.ok(config.args.includes("-NoProfile"), "a user profile must not alter agent command results");
});
