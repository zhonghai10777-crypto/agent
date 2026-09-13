// Run by the packaged Electron binary with ELECTRON_RUN_AS_NODE=1.
// This proves native/WASM loading and PTY output/exit, not desktop UI behavior.
const assert = require("node:assert/strict");
const path = require("node:path");
const appAsar = path.resolve(process.argv[2]);
const { PhotonImage } = require(path.join(appAsar, "node_modules", "@silvia-odwyer", "photon-node"));
const png = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAEklEQVR4nGPQSLnzHx9mGBkKAOz6mcHK/OviAAAAAElFTkSuQmCC";
const decoded = PhotonImage.new_from_byteslice(Buffer.from(png, "base64"));
try {
  assert.equal(decoded.get_width(), 8);
  assert.equal(decoded.get_height(), 8);
} finally { decoded.free(); }

// Load through app.asar as production does. node-pty itself resolves the
// matching native binary and its helper into app.asar.unpacked.
const pty = require(path.join(appAsar, "node_modules", "node-pty"));
const windows = process.platform === "win32";
const terminal = pty.spawn(windows ? process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe" : "/bin/sh",
  windows ? ["/d", "/c", "echo PI_PACKAGE_PTY_OK"] : ["-c", "printf 'PI_PACKAGE_PTY_OK\\n'"], {
    name: "xterm-256color", cols: 80, rows: 24, cwd: process.cwd(), env: process.env,
  });
let output = "";
const timeout = setTimeout(() => { terminal.kill(); console.error("Packaged PTY timed out"); process.exitCode = 1; }, 10_000);
terminal.onData((data) => { output = (output + data).slice(-4096); });
terminal.onExit(({ exitCode }) => {
  clearTimeout(timeout);
  assert.equal(exitCode, 0);
  assert.match(output, /PI_PACKAGE_PTY_OK/);
  console.log(JSON.stringify({ electronVersion: process.versions.electron, modulesAbi: process.versions.modules,
    platform: process.platform, architecture: process.arch, photonImage: { width: 8, height: 8 }, terminalExitCode: exitCode,
    scope: "Packaged runtime in Node mode; actual asar native/WASM dependencies; desktop UI not exercised." }));
});
