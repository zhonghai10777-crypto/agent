import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPowerShellConfig, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  POWERSHELL_ENCODING_PREAMBLE,
  withPowerShellEncodingPreamble,
  windowsPowerShellEncodingExtensionFactory,
} from "../dist/windows-powershell-encoding.js";

const onWindows = process.platform === "win32";

/** `windowsPowerShellEncodingExtensionFactory` branches on `process.platform`, so both branches are reachable from any host. */
function withPlatform(platform: string, run: () => void): void {
  const realPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    run();
  } finally {
    Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
  }
}

/** Minimal ExtensionAPI double that only records event subscriptions. */
function captureEventHandlers(): { api: ExtensionAPI; handlers: Record<string, (event: never) => unknown> } {
  const handlers: Record<string, (event: never) => unknown> = {};
  const api = {
    on: (event: string, handler: (event: never) => unknown) => {
      handlers[event] = handler;
    },
  } as unknown as ExtensionAPI;
  return { api, handlers };
}

test("the encoding extension only registers where the powershell tool exists", () => {
  for (const platform of ["darwin", "linux"]) {
    withPlatform(platform, () => {
      assert.equal(
        windowsPowerShellEncodingExtensionFactory(),
        undefined,
        `${platform} sessions run pi's bash tool and must not load the extension`,
      );
    });
  }
  withPlatform("win32", () => {
    assert.equal(typeof windowsPowerShellEncodingExtensionFactory(), "function");
  });
});

test("the preamble precedes the command verbatim and is never doubled", () => {
  const command = "Get-ChildItem '中文目录'";
  const prefixed = withPowerShellEncodingPreamble(command);
  assert.equal(prefixed, `${POWERSHELL_ENCODING_PREAMBLE}\n${command}`, "newline join, like pi's bash commandPrefix");
  assert.equal(withPowerShellEncodingPreamble(prefixed), prefixed, "already-prefixed commands are left alone");
  assert.equal(withPowerShellEncodingPreamble(""), "", "empty commands stay empty");
  assert.equal(withPowerShellEncodingPreamble("   \n\t"), "   \n\t", "whitespace-only commands stay untouched");
});

test("the tool_call handler rewrites powershell commands and nothing else", () => {
  withPlatform("win32", () => {
    const factory = windowsPowerShellEncodingExtensionFactory();
    assert.ok(factory);
    const { api, handlers } = captureEventHandlers();
    factory(api);
    const handler = handlers["tool_call"];
    assert.equal(typeof handler, "function", "the extension must subscribe to tool_call");

    const powershell = { type: "tool_call", toolName: "powershell", toolCallId: "t1", input: { command: "Get-Date" } };
    (handler as (event: unknown) => unknown)(powershell);
    assert.equal(
      (powershell.input as { command: string }).command,
      withPowerShellEncodingPreamble("Get-Date"),
      "powershell commands get the preamble",
    );

    const bash = { type: "tool_call", toolName: "bash", toolCallId: "t2", input: { command: "ls" } };
    (handler as (event: unknown) => unknown)(bash);
    assert.equal((bash.input as { command: string }).command, "ls", "the bash tool must never be touched");
  });
});

/** Runs a command exactly the way pi's powershell tool does and decodes output as pi does (UTF-8). */
function runLikePi(command: string, cwd: string): { stdout: string; status: number | null } {
  const config = getPowerShellConfig();
  const result = spawnSync(config.shell, [...config.args, withPowerShellEncodingPreamble(command)], {
    windowsHide: true,
    timeout: 30000,
    cwd,
  });
  return { stdout: new TextDecoder().decode(result.stdout ?? []), status: result.status };
}

test("prefixed cmdlet and native output reach the UTF-8 decoder intact", { skip: !onWindows }, () => {
  // Without the preamble, PowerShell writes OEM code page 936 bytes on zh-CN
  // Windows and pi's UTF-8 decode turns them into mojibake.
  const cmdlet = runLikePi("Write-Output '中文测试'", tmpdir());
  assert.equal(cmdlet.status, 0);
  assert.equal(cmdlet.stdout.trim(), "中文测试", `cmdlet output garbled or polluted: ${JSON.stringify(cmdlet.stdout)}`);

  const native = runLikePi("cmd /c echo 中文", tmpdir());
  assert.equal(native.status, 0);
  assert.ok(native.stdout.includes("中文"), `native output garbled: ${JSON.stringify(native.stdout)}`);
  assert.ok(!native.stdout.includes("\uFFFD"), "no replacement characters may survive");
});

test("prefixed reads of BOM-less UTF-8 files decode correctly in memory", { skip: !onWindows }, () => {
  // $PSDefaultParameterValues['Get-Content:Encoding'] fixes what used to be a
  // silent double error: GBK misread of UTF-8 bytes, hidden only while output
  // was re-encoded as GBK.
  const dir = mkdtempSync(join(tmpdir(), "pi-ps-encoding-"));
  writeFileSync(join(dir, "utf8-nobom.txt"), "第一行中文内容\n第二行TODO待办", "utf8");

  const contents = runLikePi("Get-Content 'utf8-nobom.txt'", dir);
  assert.equal(contents.status, 0);
  assert.ok(contents.stdout.includes("第一行中文内容"), `Get-Content garbled: ${JSON.stringify(contents.stdout)}`);

  const filtered = runLikePi("(Select-String -Path 'utf8-nobom.txt' -Pattern 'TODO').Line", dir);
  assert.equal(filtered.status, 0);
  assert.ok(
    filtered.stdout.includes("第二行TODO待办"),
    `in-memory processing on UTF-8 content garbled: ${JSON.stringify(filtered.stdout)}`,
  );
});

test("the preamble does not disturb exit-code reporting", { skip: !onWindows }, () => {
  const result = runLikePi("cmd /c exit 7\nWrite-Output \"code=$LASTEXITCODE\"", tmpdir());
  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes("code=7"), `$LASTEXITCODE clobbered: ${JSON.stringify(result.stdout)}`);
});
