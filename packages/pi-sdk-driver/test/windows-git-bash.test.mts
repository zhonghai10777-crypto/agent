import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  findGitBashWindows,
  resetGitBashDetectionCache,
  windowsGitBashAvailable,
  windowsGitBashPath,
  type GitBashProbe,
} from "../dist/windows-git-bash.js";

const onWindows = process.platform === "win32";

const noProbe: GitBashProbe = { registryInstallPaths: () => [], gitExecutableFromPath: () => undefined };

/** A fixture install root with a real `bin\bash.exe` on disk. */
function fixtureInstallRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "git-bash-fixture-"));
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(root, "bin", "bash.exe"), "");
  return root;
}

/** Environment whose well-known roots all miss, so only `probe` can find anything. */
function envWithoutGitBash(): NodeJS.ProcessEnv {
  const emptyRoot = mkdtempSync(join(tmpdir(), "git-bash-empty-"));
  return {
    ProgramFiles: emptyRoot,
    "ProgramFiles(x86)": join(emptyRoot, "x86"),
    LocalAppData: join(emptyRoot, "appdata"),
  } as NodeJS.ProcessEnv;
}

test("detection walks the well-known install roots first", () => {
  const root = fixtureInstallRoot();
  const bash = findGitBashWindows(
    { ...envWithoutGitBash(), ProgramFiles: root } as NodeJS.ProcessEnv,
    noProbe,
  );
  assert.equal(bash, join(root, "bin", "bash.exe"));
});

test("detection checks the per-user install root under LocalAppData", () => {
  const base = mkdtempSync(join(tmpdir(), "git-bash-local-"));
  const root = join(base, "Programs", "Git");
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(root, "bin", "bash.exe"), "");
  const bash = findGitBashWindows(
    { ...envWithoutGitBash(), LocalAppData: base } as NodeJS.ProcessEnv,
    noProbe,
  );
  assert.equal(bash, join(root, "bin", "bash.exe"));
});

test("detection falls back to the GitForWindows registry install path", () => {
  const root = fixtureInstallRoot();
  const bash = findGitBashWindows(envWithoutGitBash(), {
    registryInstallPaths: () => [root],
    gitExecutableFromPath: () => undefined,
  });
  assert.equal(bash, join(root, "bin", "bash.exe"));
});

test("detection derives bash.exe from the git.exe found on PATH", () => {
  // Default installer layout: only `<root>\cmd` is on PATH, bash.exe is in `<root>\bin`.
  const root = fixtureInstallRoot();
  mkdirSync(join(root, "cmd"), { recursive: true });
  writeFileSync(join(root, "cmd", "git.exe"), "");
  const bash = findGitBashWindows(envWithoutGitBash(), {
    registryInstallPaths: () => [],
    gitExecutableFromPath: () => join(root, "cmd", "git.exe"),
  });
  assert.equal(bash, join(root, "bin", "bash.exe"));
});

test("an explicit PI_GIT_BASH override wins", () => {
  const override = fixtureInstallRoot();
  const bashFile = join(override, "bin", "bash.exe");
  const bash = findGitBashWindows(
    { ...envWithoutGitBash(), PI_GIT_BASH: bashFile } as NodeJS.ProcessEnv,
    noProbe,
  );
  assert.equal(bash, bashFile);
});

test("a stock machine with neither Git Bash nor a probe hit finds nothing", () => {
  assert.equal(findGitBashWindows(envWithoutGitBash(), noProbe), undefined);
});

test("availability detection prepends the bin dir to this process' PATH", { skip: !onWindows }, () => {
  resetGitBashDetectionCache();
  const root = fixtureInstallRoot();
  const savedPath = process.env.PATH;
  const savedEnv = envWithoutGitBash();
  process.env.ProgramFiles = savedEnv.ProgramFiles;
  process.env["ProgramFiles(x86)"] = savedEnv["ProgramFiles(x86)"];
  process.env.LocalAppData = savedEnv.LocalAppData;
  process.env.PI_GIT_BASH = "";
  try {
    process.env.PATH = ["C:\\Windows\\System32", "C:\\Windows"].join(delimiter);
    assert.equal(windowsGitBashAvailable({ registryInstallPaths: () => [root], gitExecutableFromPath: () => undefined }), true);
    const entries = (process.env.PATH ?? "").split(delimiter);
    assert.equal(entries[0], join(root, "bin"), "Git's bin dir must lead PATH so `where bash` skips the WSL shim");
    assert.equal(entries[1], "C:\\Windows\\System32");
    assert.equal(windowsGitBashPath(), join(root, "bin", "bash.exe"), "the detected path is cached");
  } finally {
    process.env.PATH = savedPath;
    delete process.env.PI_GIT_BASH;
    delete process.env.ProgramFiles;
    delete process.env["ProgramFiles(x86)"];
    delete process.env.LocalAppData;
    resetGitBashDetectionCache();
  }
});

test("a bin dir already ahead of System32 is left alone", { skip: !onWindows }, () => {
  resetGitBashDetectionCache();
  const root = fixtureInstallRoot();
  const binDir = join(root, "bin");
  const savedPath = process.env.PATH;
  const savedEnv = envWithoutGitBash();
  process.env.ProgramFiles = savedEnv.ProgramFiles;
  process.env["ProgramFiles(x86)"] = savedEnv["ProgramFiles(x86)"];
  process.env.LocalAppData = savedEnv.LocalAppData;
  process.env.PI_GIT_BASH = "";
  try {
    const original = [binDir, "C:\\Windows\\System32"].join(delimiter);
    process.env.PATH = original;
    assert.equal(windowsGitBashAvailable({ registryInstallPaths: () => [root], gitExecutableFromPath: () => undefined }), true);
    assert.equal(process.env.PATH, original, "no duplicate prepend when PATH order is already correct");
  } finally {
    process.env.PATH = savedPath;
    resetGitBashDetectionCache();
  }
});

test("no detection hit leaves PATH untouched", { skip: !onWindows }, () => {
  resetGitBashDetectionCache();
  const savedPath = process.env.PATH;
  const savedEnv = envWithoutGitBash();
  process.env.ProgramFiles = savedEnv.ProgramFiles;
  process.env["ProgramFiles(x86)"] = savedEnv["ProgramFiles(x86)"];
  process.env.LocalAppData = savedEnv.LocalAppData;
  process.env.PI_GIT_BASH = "";
  try {
    process.env.PATH = "C:\\Windows\\System32";
    assert.equal(windowsGitBashAvailable(noProbe), false);
    assert.equal(process.env.PATH, "C:\\Windows\\System32");
  } finally {
    process.env.PATH = savedPath;
    resetGitBashDetectionCache();
  }
});
