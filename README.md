# Agent

A Codex-style desktop app for the [`pi`](https://github.com/earendil-works/pi) agent,
built for coding, office documents and working with your own reference material.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Latest release](https://img.shields.io/github/v/release/zhonghai10777-crypto/agent?include_prereleases&label=release)](https://github.com/zhonghai10777-crypto/agent/releases)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](#install)

Agent gives `pi` a native home on the desktop: a threaded timeline of your agent
sessions, Word and Excel tools, a searchable local library, web access, git
worktrees per thread, an integrated terminal and a diff viewer, all backed by
`pi`'s own session files as the source of truth. It is a UI shell around
[`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent),
not a separate agent runtime: session management, model/auth setup and agent
execution all run through upstream `pi`. The interface is available in Simplified
Chinese (the default) and English.

## Features

**Conversations**

- **Threaded timeline**: each session renders as messages and collapsible tool
  calls, Codex-style, with prompt navigation and search across threads.
- **Queue or steer**: while a run is going, <kbd>Enter</kbd> queues a follow-up and
  the steer shortcut redirects the current run.
- **Long sessions**: automatic context compaction keeps a thread going, with the
  compaction shown in the timeline.
- **Session archive**: archive threads you're done with to keep the sidebar tidy.

**Documents and knowledge**

- **Read documents**: the assistant reads PDF, Word, Excel and plain-text files,
  including GBK/GB18030 and UTF-16 text, and pages through long ones.
- **Word and Excel output**: create and edit `.docx` and `.xlsx` files, including
  Word documents composed from Markdown and templates. Every write is shown for
  confirmation and saved as a new file; the original is never overwritten.
- **Local library**: point Agent at folders of standards, procedures and reference
  documents; they are indexed on this machine and the assistant searches them.
- **Web access**: web search (DeepSeek, Bocha, Tavily or SearXNG) and page reading
  when a question needs current information.
- **Images**: paste or drag images into the prompt. With DeepSeek image assistance,
  text-only models get a description from a vision model first.

**Coding**

- **Git worktrees per thread**: start a thread in the workspace directly (`Local`)
  or in an isolated git worktree so parallel work never collides.
- **Integrated terminal**: a real PTY terminal (via `node-pty`) docked in the app.
- **Changes and files panels**: review changed files and browse the workspace in a
  side panel (toggle with <kbd>⌘/Ctrl</kbd>+<kbd>D</kbd>).
- **Composer niceties**: `@`-mention files, slash commands and skills.
- **Multi-agent orchestration**: an orchestrator thread can spin up and supervise
  child worker threads.
- **Skills & extensions**: manage `pi` skills and extensions from a dedicated view.

**Safety and the app**

- **Read-only or writable**: a per-thread permission mode. Read-only lets the agent
  look but not edit files, run commands or write Office files.
- **Nothing lost on quit**: quitting (or closing the last window on Windows) asks
  first when tasks are still running.
- **Encrypted keys**: API keys are stored encrypted with the OS keychain (Electron
  `safeStorage`).
- **Multiple providers**: connect model providers via OAuth or API key under
  **Settings → Providers**.
- **Appearance and notifications**: light and dark themes with presets, and an OS
  notification when a background run finishes.

## Install

Agent is in public beta for **Windows 10/11 x64**, **macOS (Apple Silicon)** and
**Linux x64**. Download the latest release from the
[Releases page](https://github.com/zhonghai10777-crypto/agent/releases), or check
for one under **Settings → General → Application updates**.

### Windows

- Use the **setup** installer (`Agent-<version>-x64-setup.exe`), or the **portable**
  `.exe` if you cannot install software. The portable build has no Start menu
  entry, so Windows may not show its notifications.
- Install [Git for Windows](https://git-scm.com/download/win) for the full agent
  workflow. The agent runs shell commands in Git Bash when it is installed and falls
  back to PowerShell otherwise, and worktrees and the changes panel need `git`.
- Where Agent keeps its data:

  | Location | Contents |
  | --- | --- |
  | `%APPDATA%\Agent` | settings, encrypted keys, workspace and thread catalogs |
  | `%LOCALAPPDATA%\Agent` | git worktrees and the local library index (kept out of the roaming profile) |
  | `%USERPROFILE%\.pi\agent` | `pi`'s own sessions, auth and settings, shared with the `pi` CLI |

### macOS

Drag `Agent.app` into `/Applications` and launch it. Releases are signed and
notarized. To update, download the newer release and replace the app.

### From source

See [Development](#development). Building from source is intended for contributors,
not as the primary install path.

## Quickstart

1. Install Agent and launch it.
2. Open **Settings → Providers** and connect a model provider (OAuth or API key).
3. Add a workspace (a local project folder).
4. Click **New thread**, pick `Local` or `Worktree`, and send your first prompt.

You need valid model/provider authentication that `pi` supports; Agent uses `pi`'s
auth and session state, so anything you've already configured with the `pi` CLI
carries over.

## Runtime modes

Choose the mode under **Settings → General**. A mode change is saved immediately
and takes effect after restarting Agent.

- **Light mode** is the default for everyday questions, documents and read-only
  assistance. It keeps models, web access, document reading, the local library and
  confirmed Word/Excel writes available, while disabling terminal commands, code
  file changes, Git worktrees, local skills/extensions and multi-agent orchestration.
- **Agent mode** enables the complete coding-agent workflow, including terminal,
  file mutation, worktrees, skills/extensions and child agents.

For Windows computers with 4 GB of RAM, use Light mode, keep one workspace open,
and avoid running another Electron app or browser with many tabs at the same time.
Agent mode is intended for machines with more memory or short, focused coding runs.

## Architecture

Agent is an Electron app organized around a tight main/preload/renderer boundary,
sitting on top of the `pi` runtime:

- **Renderer** (`apps/desktop/src`): the React UI (timeline, composer, panels,
  terminal, settings). It talks to the main process only through a typed IPC surface.
- **Preload** (`apps/desktop/electron/preload.ts`): the narrow bridge that exposes
  that IPC surface to the renderer; the renderer gets no broad Node access.
- **Main** (`apps/desktop/electron`): the Node side, covering windowing, session
  supervision, document and Office tools, the local library, web access, worktrees,
  terminal PTYs, notifications and persistence.
- **`packages/pi-sdk-driver`**: a thin adapter from the desktop app to
  `@earendil-works/pi-coding-agent`. It stays close to upstream `pi` and does not
  fork or reimplement runtime behavior; on Windows it picks Git Bash or PowerShell
  for the agent's shell and keeps its output in UTF-8.
- **JSONL session files as the source of truth**: `pi` persists each session as a
  JSONL transcript on disk; Agent reads those files as the authoritative record for
  closed sessions rather than keeping a divergent copy.

Supporting packages: `packages/session-driver` (shared session driver types) and
`packages/catalogs` (lightweight workspace/session catalog state).

## Development

Requires Node 20+ and [pnpm](https://pnpm.io) (managed via `corepack`). pnpm is
the supported package manager, and `pnpm-lock.yaml` is the authoritative lockfile.

```bash
corepack enable
pnpm install
```

Common commands (run from the repo root):

```bash
pnpm dev         # run the desktop app in development (electron-vite, hot reload)
pnpm build       # build all workspaces
pnpm typecheck   # type-check all workspaces
pnpm lint        # lint all workspaces
pnpm test        # run each workspace's tests (desktop runs the core E2E lane)
```

Desktop end-to-end tests use a Playwright + Electron harness and are organized into
lanes. The default `pnpm test` runs the `core` lane; to run everything:

```bash
pnpm --filter @pi-gui/desktop run test:e2e:all   # core + live + native
```

Package installers locally:

```bash
pnpm package:win                                   # Windows setup + portable
pnpm --filter @pi-gui/desktop run package:linux    # Linux AppImage + deb
```

See [`apps/desktop/README.md`](./apps/desktop/README.md) for lane details, the
Windows packaging workflows and platform-specific notes.

## Repository layout

- `apps/desktop`: the Electron app (renderer UI + main/preload).
- `packages/pi-sdk-driver`: adapter over `@earendil-works/pi-coding-agent`.
- `packages/session-driver`: shared session driver types.
- `packages/catalogs`: workspace/session catalog state.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup,
verification expectations and the desktop test lanes. Desktop changes are expected
to be verified on the real Electron surface, not only by unit tests.

## Computer use

Native computer use is not built into Agent. Desktop/browser control is available
separately through the author's standalone
[`computer-use-mcp`](https://github.com/minghinmatthewlam/computer-use-mcp) server,
which any MCP-capable agent can use.

## Acknowledgements

- Built on [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).
- Upstream runtime and ecosystem by [`earendil-works/pi`](https://github.com/earendil-works/pi).

## License

[MIT](./LICENSE) © Matthew Lam and zhonghai10777-crypto contributors
