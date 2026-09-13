# Desktop App

Codex-style Electron shell for `pi`, with Playwright E2E coverage organized by test lane.

macOS remains the source of truth for desktop UI verification. Linux is supported for packaging and manual validation, with CI packaging checks to catch AppImage regressions.

## Setup

Install workspace dependencies once:

```bash
corepack enable
pnpm install
```

Build the desktop app:

```bash
pnpm --filter @pi-gui/desktop build
```

Run the app in development:

```bash
pnpm --filter @pi-gui/desktop dev
```

`dev` now runs through `electron-vite`, so renderer edits hot-update in place and Electron `main` / `preload` changes trigger the appropriate reload or restart behavior automatically. The desktop dev launcher also rebuilds the shared workspace packages up front and keeps them in watch mode so Node-side package changes can be picked up without manual rebuilds.

Run the built app locally without packaging:

```bash
pnpm --filter @pi-gui/desktop preview
```

Package a Linux AppImage locally:

```bash
pnpm --filter @pi-gui/desktop run package:linux
```

Package Windows installers locally:

```bash
pnpm --filter @pi-gui/desktop run package:win
```

Unpacked Windows build (faster iteration):

```bash
pnpm --filter @pi-gui/desktop run package:win:dir
```

On Windows, `package:win*` routes through `scripts/package-windows.mjs`, which prefers the ASCII repo-local `tools/pnpm.cmd` shim and redirects `ELECTRON_BUILDER_CACHE` / `LOCALAPPDATA` into `.cache/` under the repo. This avoids electron-builder failures when `pnpm` lives under a non-ASCII `%USERPROFILE%` or when Developer Mode / elevation is unavailable for winCodeSign symlink extraction. Set `ELECTRON_MIRROR` if Electron downloads are flaky in your region.

Live agent tests use your existing `pi` runtime and provider auth. If local `pi` runs do not work, the `live` lane will not be meaningful either.

## Update distribution

Settings → General → Application updates provides manual update checks on Windows,
macOS and Linux. Automatic checks still run in the main process. The UI distinguishes
current versions, unavailable/private sources, network failures and rate limits.

Set `PI_APP_UPDATE_REPOSITORY=owner/release-repo` when building to embed a separate
GitHub distribution repository. Users can override the repository with the same
environment variable when launching the app. Only the repository name is embedded;
the source repository and its visibility are unchanged. Publish version tags and
their downloadable installers to that distribution repository before distributing
the configured app. This setting does not create or publish a repository.

For private distribution, each user can supply their own fine-grained GitHub token
through `PI_APP_UPDATE_TOKEN` when launching. Restrict it to the distribution repo
with **Contents: read-only** access. Tokens are used only by the main process for
GitHub API requests, never returned through IPC or included in builds. Do not ship
a maintainer's token. Download links open GitHub in the user's browser, which needs
its own signed-in session for private release assets.

The default repository remains `zhonghai10777-crypto/agent` for existing users.
Anonymous updates require a publicly readable distribution repository; without
one, private-repository checks report an access error rather than “up to date”.

## Model image input

Settings → Providers → Custom endpoints lets you enable **Image input** for each
vision-capable model. The setting persists across edits and restarts and applies
to the next turn in an open session. Images are sent directly to that model.

Official DeepSeek `deepseek-flash` (V4.1 Flash), `deepseek-v4-flash`, and
`deepseek-v4-flash-vision-exp` default to image input at `https://api.deepseek.com`
or its `/v1` endpoint, following the [DeepSeek vision documentation](https://api-docs.deepseek.com/zh-cn/guides/vision).
Startup fills missing image capabilities in older app-managed configurations,
keeping an original-file backup and preserving explicit choices. Other custom
models require an explicit image setting. If neither native image input nor an
image assistance route is available, sending a screenshot shows a configuration
error and keeps the draft and attachments for retry.

## DeepSeek image assistance

Official DeepSeek `deepseek-v4-pro` and `deepseek-v4-flash` sessions configured for text input can analyze
attached images with `deepseek-flash`, then answer with the original
primary model, thinking level, context and tools. Settings → Models controls
**Automatic image analysis**, shows the auxiliary model and account source, and
offers local configuration validation or a confirmed small-image connection test.
The connection image test and normal image analysis add provider usage.

Routing checks the selected provider configuration and the normalized official
HTTPS endpoint. Credentials come from that same configuration. Auxiliary requests
always go to `https://api.deepseek.com/chat/completions`; custom endpoints cannot
borrow another provider's key. Image-capable primary models keep their native
image path. Global Pi `images.blockImages` takes precedence. Disabled, unsupported,
invalid, unauthorized or failed images block the text-model request and retain
the original message for an explicit retry.

Original images stay in the Pi session. Only the outgoing context is projected to
validated textual evidence. Evidence, stable entry/image bindings, status and
separate auxiliary usage are saved atomically under the profile's `vision-records`
directory. Existing session JSONL and older snapshots remain readable. Opening a
session never starts recognition; missing evidence is filled when a model request
needs it. Restarted unfinished work is marked interrupted and requires an explicit
retry, because the server may already have received the previous request.

Queue edits are applied before recognition at dequeue time. Stop cancels waiting
work, image HTTP requests and the primary-model handoff. Retry continues an
accepted Pi turn without appending another user message. Models and thinking
levels are frozen while a turn runs. Forks and tree navigation expose only images
in the active branch. Manual/automatic compaction and branch summaries consume
the same evidence; authorized originals remain available to `inspect_images`.
This read-only tool supports a specific follow-up question and an optional
normalized crop without allowing arbitrary paths or URLs. Plan and Light retain
their existing restrictions on commands, file writes and child agents.

Images are decoded in a cancellable worker after byte/header limits are checked.
Supported static formats are PNG, JPEG, WebP and GIF; animated images require
conversion to a static frame. Defaults are eight images per message, 10 MiB per
image, 20 MiB per message, a 32 MiB serialized body, 8192 pixels per dimension and
20 megapixels. Requests are serialized across sessions. A turn's automatic image
work shares three total attempts and a 180-second deadline starting at its first
recognition; each attempt is limited to 60 seconds. Structure repair and output
expansion consume that same budget. Already saved evidence remains usable after
the deadline. A very large backlog may require an explicit retry to fill its
remaining images; successful partial work is retained. A distinct `inspect_images`
call starts its own bounded operation.

Compatibility remains pinned to Pi 0.84.4. Image routing wraps the session's
existing stream function and preserves its payload transforms. Accepted-message
retry uses the verified Pi runner through a version-guarded `pi-compat` adapter;
upgrade this contract and its SDK tests together when changing Pi versions.

Feature-scoped checks (no complete core suite):

```bash
pnpm --filter @pi-gui/desktop build
pnpm --filter @pi-gui/desktop typecheck
pnpm --filter @pi-gui/pi-sdk-driver exec node --test test/vision-client.test.mts test/vision-router.test.mts test/vision-stream-adapter.test.mts test/vision-sdk-contract.test.mts
pnpm exec playwright test -c apps/desktop/playwright.config.ts apps/desktop/tests/unit/vision-store.spec.ts apps/desktop/tests/unit/vision-image.spec.ts
pnpm --filter @pi-gui/desktop run test:e2e:runner -- apps/desktop/tests/core/vision-routing.spec.ts
```

The Electron tests use isolated profiles, synthetic credentials and a local HTTP
server, validating real serialized provider bodies and the actual image worker.
They do not prove live DeepSeek availability. The small-image live contract is
skipped unless `PI_APP_TEST_LIVE_VISION=1` and a dedicated test account key is
provided through `PI_APP_TEST_VISION_API_KEY`:

```bash
pnpm --filter @pi-gui/pi-sdk-driver exec node --test test/vision-live.test.mts
```

The manually dispatched **DeepSeek Vision Windows** workflow builds the actual
Windows installer and portable package, checks packaged dependencies and launches
`win-unpacked/agent.exe` for native Flash and auxiliary Pro image coverage. The
auxiliary test also copies the unpacked app into a Chinese path for Stop/retry/reopen coverage.
It does not publish a release. A local Windows run uses `pnpm package:win`,
`pnpm --dir apps/desktop run verify:packaged-runtime-deps:windows`, then the
`tests/production/vision-routing-packaged.spec.ts` Playwright spec with
`PI_APP_TEST_PACKAGED_VISION=1`. The packaged test retains its copied installation
outside the report directory. Ordinary-user installation without development
dependencies is a separate release acceptance step.

The **Windows Beta Candidate** workflow additionally runs the packaged document
Worker and terminal tests, permission guards, actual Windows junction boundaries
and credential recovery. It records the actual packaged Electron/Node/Chromium
versions, commit, run identity, SHA-256 and Authenticode status. These tests use
synthetic local HTTP responses; they do not exercise the NSIS installer, portable
launcher, previous-version installation upgrades or real provider accounts.

The packaged dependency verifier also starts the target Electron binary in Node
mode to decode a synthetic PNG through Photon WASM and check `node-pty` output
and exit. That check proves package loading on the current OS; the Playwright
specs below are still required to verify desktop interaction.

After building a directory package, run only the relevant opt-in specs:

```bash
pnpm exec cross-env PI_APP_TEST_MODE=background PI_APP_TEST_PACKAGED_DOCUMENTS=1 PI_APP_TEST_PACKAGED_NATIVE_VISION=1 PI_APP_TEST_PACKAGED_VISION=1 pnpm exec playwright test -c apps/desktop/playwright.config.ts apps/desktop/tests/production/document-packaged.spec.ts apps/desktop/tests/production/vision-native-packaged.spec.ts apps/desktop/tests/production/vision-routing-packaged.spec.ts apps/desktop/tests/production/packaged-terminal.spec.ts --output=packaged-beta-results
node apps/desktop/scripts/inspect-electron-runtime.mjs --executable apps/desktop/release/win-unpacked/agent.exe --output apps/desktop/release/electron-runtime.json
```

`PI_APP_TEST_RELEASE_DIR` selects a separate package directory for the shared
packaged harness and dependency verifier. On Windows, the copied auxiliary-vision
test uses `PI_APP_TEST_VISION_EXE` to override its source EXE. The same document,
native-vision, auxiliary-vision and terminal specs can run on macOS directory
packages, with their results reported as macOS evidence only.

For bounded library measurements, build once and run
`tests/production/library-capacity-profile.spec.ts` with
`PI_APP_TEST_LIBRARY_PROFILE=1` and `PI_APP_TEST_MODE=background`. Each of the
three synthetic sizes retains a `measurement.json` with input bytes, actual
indexed text characters, memory, event-loop delay and search latency. Host
measurements do not establish Windows 4 GB or 8 GB hardware support.

## Test Lanes

Use the smallest lane that matches the changed surface.

- `core`
  Background-friendly Electron UI coverage. This is the default lane for renderer, sidebar, composer, persistence, settings, skills, and worktree UI behavior.

  ```bash
  pnpm --filter @pi-gui/desktop run test:e2e
  pnpm --filter @pi-gui/desktop run test:e2e:core
  ```

- `live`
  Real runtime/provider coverage. Use this when the change depends on an actual run, transcript item, tool call, or background notification.

  ```bash
  pnpm --filter @pi-gui/desktop run test:e2e:live
  ```

- `native`
  macOS OS-surface coverage such as folder pickers, image pickers, and real clipboard paste. This lane is foreground-only and can take focus.

  ```bash
  pnpm --filter @pi-gui/desktop run test:e2e:native
  ```

- `production`
  Opt-in higher-fidelity smokes that stay out of the default fast lanes. Use these for real-auth `live` checks, packaged `.app` launch, and real macOS open-panel coverage.

  ```bash
  pnpm --filter @pi-gui/desktop run test:prod:real-auth-contract
  pnpm --filter @pi-gui/desktop run test:prod:packaged-smoke
  pnpm --filter @pi-gui/desktop run test:prod:packaged-computer-use-parity
  pnpm --filter @pi-gui/desktop run test:prod:packaged-computer-use-background
  pnpm --filter @pi-gui/desktop run test:prod:applications-relaunch
  pnpm --filter @pi-gui/desktop run test:prod:release-zip-smoke
  pnpm --filter @pi-gui/desktop run test:prod:open-folder-real
  ```

Run all desktop lanes:

```bash
pnpm --filter @pi-gui/desktop run test:e2e:all
```

For mac-first CI, use:

```bash
pnpm --filter @pi-gui/desktop run test:e2e:ci:mac
```

Linux CI currently validates packaging via:

```bash
pnpm --filter @pi-gui/desktop run package:linux
pnpm --dir apps/desktop run verify:packaged-runtime-deps:linux
```

Windows release CI validates packaging via:

```bash
pnpm --filter @pi-gui/desktop run package:win:dir
pnpm --dir apps/desktop run verify:packaged-runtime-deps:windows
```

## Focus And Foreground Rules

- `core` and most `live` scripts set `PI_APP_TEST_MODE=background` for you. Agents normally should not set that env var manually.
- `native` scripts set `PI_APP_TEST_MODE=foreground` for you and may steal focus.
- If a native test fails, rerun it with a clean foreground window before assuming the product is broken.
- Picker tests rely on macOS Accessibility/UI scripting. If folder or image picker automation cannot type into the dialog, check system Accessibility permissions first.
- `production` open-panel coverage also relies on macOS Accessibility/UI scripting and should be run with the app kept frontmost.

## Playwright Vs Computer Use

Prefer the repo lanes first. They are deterministic, scriptable, and the right source of truth for normal development and CI.

- Use `core` when the behavior lives inside the Electron window and should stay background-friendly.
- Use `live` when you need a real run, transcript item, tool call, queued message, or other runtime-backed behavior.
- Use `native` or `production` when the surface is a real macOS dialog, picker, clipboard path, installed `.app`, or packaged release artifact.

Use manual Computer Use smoke only as a complement, not a replacement.

- If the local Codex skill `$pi-gui-computer-use-smoke` is installed, use it for believable release-readiness sweeps on the installed app and for focus-hostile macOS surfaces that are awkward or disruptive in Playwright.
- The reason to use Computer Use is product confidence, not determinism. It is useful when you want to see the real installed app behave correctly while minimizing disruption to the laptop.
- Keep Playwright as the primary regression signal. Computer Use should not replace lane coverage for `core`, `live`, `native`, or `production`, and it should not become a hidden repo dependency.
- Treat real open-folder and native file-picker checks in Computer Use as best-effort smoke coverage unless the workflow is explicitly being validated there.

## Targeted Commands

Use a targeted script while iterating.
Rerun the matching lane before closing for `core` and `live`.
For `native`, rerun the targeted native spec by default and expand to `test:e2e:native` only when the change touches shared native helpers, multiple native specs, or lane-wide native behavior.

```bash
pnpm --filter @pi-gui/desktop run test:core:worktrees
pnpm --filter @pi-gui/desktop run test:core:persistence
pnpm --filter @pi-gui/desktop run test:live:tool-calls
pnpm --filter @pi-gui/desktop run test:native:paste
pnpm --filter @pi-gui/desktop run test:native:open-folder
pnpm --filter @pi-gui/desktop run test:native:attach-image
pnpm --filter @pi-gui/desktop run test:prod:real-auth-contract
pnpm --filter @pi-gui/desktop run test:prod:packaged-smoke
pnpm --filter @pi-gui/desktop run test:prod:applications-relaunch
pnpm --filter @pi-gui/desktop run test:prod:release-zip-smoke
pnpm --filter @pi-gui/desktop run test:prod:open-folder-real
```

For real-auth `live` specs, opt in explicitly:

```bash
PI_APP_REAL_AUTH=1 PI_APP_REAL_AUTH_SOURCE_DIR=/absolute/path/to/agent \
  pnpm --filter @pi-gui/desktop run test:e2e:runner -- apps/desktop/tests/live/submit-run.spec.ts

PI_APP_REAL_AUTH=1 PI_APP_REAL_AUTH_SOURCE_DIR=/absolute/path/to/agent \
  pnpm --filter @pi-gui/desktop run test:e2e:runner -- apps/desktop/tests/live/tool-calls.spec.ts
```

For dev-loop verification, use:

```bash
pnpm --filter @pi-gui/desktop run test:dev:reload
```

That spec launches the app in development mode, edits isolated probe modules for renderer/Electron/shared-package wiring, and proves the running window picks up the changes.

## Test Conventions

- Shared helpers live in [`tests/helpers/electron-app.ts`](./tests/helpers/electron-app.ts). Extend them instead of adding another Electron harness.
- Prefer real clicks, typing, keyboard shortcuts, and visible assertions.
- Avoid direct IPC shortcuts for visible behavior unless the user surface does not exist yet. If you must use one, document why the surface gap exists.
- `pasteTinyPng()` drives the renderer paste handler directly and is appropriate for background-safe coverage.
- `pasteTinyPngViaClipboard()` uses Electron clipboard plus `webContents.paste()` and is appropriate for foreground/native coverage.
- `tests/production/real-auth-contract.spec.ts` proves the default non-real-auth path still seeds a temporary fake-auth agent dir and keeps real-auth coverage opt-in.
- `tests/production/packaged-smoke.spec.ts` proves the packaged `.app` bundle launches and can start a thread through the real UI.
- `test:prod:packaged-computer-use-parity` builds once, verifies Computer Use failure shaping and timeline failure UI, packages the `.app` once, verifies the bundled Computer Use helper, extension, locked-use self-test, top-level @ extension surface, and packaged locked-readiness status, and then runs the real background Calculator/TextEdit cursor and focus probe with target-focus guarding while tolerating unrelated user focus changes. If the desktop is locked, it still runs the package-level checks and then stops before the background probe with `COMPUTER_USE_PARITY_GATE_BLOCKED`. Use this as the main Computer Use parity gate before claiming Codex-level behavior.
- `test:prod:packaged-computer-use` packages the `.app` and verifies the bundled Computer Use helper, extension, locked-use self-test, and top-level @ extension surface.
- `test:prod:packaged-computer-use-background` packages the `.app` and runs the real Computer Use helper against background Calculator and TextEdit flows without taking focus when macOS permissions allow it.
- `test:prod:installed-computer-use-parity` builds current local artifacts, verifies `/Applications/pi-gui.app` carries the freshly built `out/**` payload, runtime workspace dependency payloads, and native Computer Use helper app payload, verifies Computer Use failure shaping and timeline UI, checks installed extension surfacing, helper background-safety capabilities, and locked-readiness status, then runs the installed background Calculator/TextEdit helper probe in preserve-frontmost mode when the desktop is unlocked. Preserve-frontmost mode skips the intentionally hazardous coordinate/physical fallback rejection probes so a stale helper cannot send fallback input into the user's active app, keeps helper-initiated physical mouse warps forbidden, and tolerates unrelated user pointer/focus changes while the active-user proof is running. If the desktop is locked it prints `COMPUTER_USE_INSTALLED_PARITY_GATE_SKIPPED installed-background-probe desktop=locked`; the gate later reruns the probe if the desktop becomes unlocked, or blocks with `COMPUTER_USE_INSTALLED_PARITY_GATE_BLOCKED` instead of passing by skipped live coverage. Full completion still requires locked-use active-turn wiring, explicit lock-screen E2E confirmation, and real-auth live composer coverage.
- `test:prod:installed-computer-use-background` runs the same preserve-frontmost background Calculator/TextEdit helper probe against `/Applications/pi-gui.app`; use it after installing a new build to catch stale installed helpers before live UI testing without forcing Finder to the front. The default non-preserve background probe keeps the runtime coordinate/physical fallback rejection coverage on a controlled Finder baseline.
- `test:prod:installed-computer-use-extension-surface` launches `/Applications/pi-gui.app` with isolated user data and verifies the installed app surfaces Computer Use as a top-level built-in extension in both Extensions and `@` mention flows, then clicks the Settings locked-use action through a non-mutating test hook to prove the installed UI would run the correct installer action.
- `test:prod:installed-computer-use-locked-use-self-test` launches `/Applications/pi-gui.app` in test mode and verifies the installed helper can complete the trusted-desktop locked-use active-turn protocol through the installed desktop process.
- `test:prod:installed-computer-use-live` launches `/Applications/pi-gui.app` with isolated test user data and real auth, sends a Computer Use prompt through the real composer, and fails if Calculator becomes frontmost, tool rows error, the run terminates generically, or the model uses `type_text` instead of Calculator clicks. It requires `PI_APP_REAL_AUTH=1` and `PI_APP_REAL_AUTH_SOURCE_DIR=/absolute/path/to/agent`, and the normal installed app should be idle/closed so Electron's single-instance lock does not route into a real user session.
- `test:prod:installed-computer-use-locked-readiness` verifies `/Applications/pi-gui.app` is signed correctly and that Locked Computer Use is actually installed/enabled before claiming real locked-screen E2E coverage. Use the `:status` variant while diagnosing a locked or not-yet-enabled machine; it reports the same state without failing.
- `test:prod:packaged-computer-use-locked-readiness:status` verifies the current packaged `.app` has the signed helper, authorization plug-in, installer, helper protocol, and status wiring without mutating macOS login authorization state.
- `tests/production/applications-relaunch.spec.ts` proves an installed copy under `/Applications` launches and relaunches with persisted state.
- `tests/production/release-zip-smoke.spec.ts` proves the packaged release ZIP can be extracted to a temp download-style path and launched through the real UI before publish.
- `tests/production/open-folder-real.spec.ts` proves the real macOS open panel can add a workspace through the empty-state button.

## Lane Map

- `tests/core`: deterministic in-window behavior
- `tests/live`: real agent/runtime behavior
- `tests/native`: macOS OS-surface behavior
- `tests/production`: opt-in higher-fidelity smokes kept out of the default lane globs

Future agents should start by reading this file, `apps/desktop/tests/AGENTS.md`, and the scripts in `apps/desktop/package.json`.
