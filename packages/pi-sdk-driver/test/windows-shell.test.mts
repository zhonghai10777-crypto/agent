import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createPowerShellToolDefinition, getPowerShellConfig } from "@earendil-works/pi-coding-agent";
import { LIGHT_MODE_EXCLUDED_TOOLS, sessionToolNames } from "../dist/windows-shell.js";

const realPlatform = process.platform;
const onWindows = realPlatform === "win32";

/** `sessionToolNames` branches on `process.platform`, so both branches are reachable from any host. */
function withPlatform(platform: string, run: () => void): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    run();
  } finally {
    Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
  }
}

test("Windows sessions run pi's powershell tool and are never handed bash", () => {
  withPlatform("win32", () => {
    const names = sessionToolNames();
    assert.deepEqual(names, ["read", "powershell", "edit", "write"]);
    assert.ok(!names?.includes("bash"), "a Windows session must not activate the POSIX-only bash tool");
  });
});

test("other platforms keep pi's own default tool selection", () => {
  for (const platform of ["darwin", "linux"]) {
    withPlatform(platform, () => {
      assert.equal(sessionToolNames(), undefined, `${platform} should defer to pi's default tools`);
    });
  }
});

test("light mode stays command-free whichever shell the platform activates", () => {
  // Light mode used to exclude only "bash". Activating "powershell" on Windows
  // would have silently handed light-mode sessions command execution.
  for (const excluded of ["bash", "powershell", "edit", "write"]) {
    assert.ok(LIGHT_MODE_EXCLUDED_TOOLS.includes(excluded), `light mode must exclude ${excluded}`);
  }

  withPlatform("win32", () => {
    const active = (sessionToolNames() ?? []).filter((name) => !LIGHT_MODE_EXCLUDED_TOOLS.includes(name));
    assert.deepEqual(active, ["read"], "light mode on Windows must leave read as the only built-in tool");
  });
});

test("the tool name we activate is the one pi registers", { skip: !onWindows }, () => {
  // Guards against pi renaming the tool: the string above would then silently
  // activate nothing, leaving Windows sessions with no shell at all.
  const definition = createPowerShellToolDefinition(process.cwd());
  assert.equal(definition.name, "powershell");
  assert.ok(sessionToolNames()?.includes(definition.name));
});

test("PowerShell is discoverable without Git or WSL installed", { skip: !onWindows }, () => {
  // The point of the switch: this must hold on a stock Windows machine, where
  // pi's bash tool has no shell to resolve.
  const config = getPowerShellConfig();
  assert.ok(existsSync(config.shell), `resolved PowerShell should exist on disk: ${config.shell}`);
  assert.ok(/(?:pwsh|powershell)\.exe$/iu.test(config.shell), `unexpected shell: ${config.shell}`);
  assert.equal(config.args.at(-1), "-Command", "the command must be passed via -Command");
  assert.ok(config.args.includes("-NoProfile"), "a user profile must not alter agent command results");
});
