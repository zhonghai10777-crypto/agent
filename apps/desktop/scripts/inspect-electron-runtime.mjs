import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(resolve(desktop, "package.json"));
const arg = (name) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const executable = resolve(arg("--executable") ?? require("electron"));
const expected = JSON.parse(readFileSync(resolve(desktop, "package.json"), "utf8")).devDependencies.electron;
const builder = parse(readFileSync(resolve(desktop, "electron-builder.yml"), "utf8"));
if (builder.electronVersion !== expected) throw new Error("Desktop and builder Electron versions disagree.");
const runtime = JSON.parse(execFileSync(executable, ["-p", "JSON.stringify({ electronVersion: process.versions.electron, nodeVersion: process.versions.node, chromeVersion: process.versions.chrome, platform: process.platform, architecture: process.arch })"], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8", timeout: 15_000,
}));
if (runtime.electronVersion !== expected) throw new Error(`Actual Electron ${runtime.electronVersion} does not match configured ${expected}.`);
const report = JSON.stringify({ ...runtime, executable }, null, 2) + "\n";
if (arg("--output")) writeFileSync(resolve(arg("--output")), report);
process.stdout.write(report);
