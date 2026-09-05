<div align="center">

# PUM

**A compact coding agent for the terminal.**

Plan, edit, run commands, review Markdown, and coordinate parallel subagents without leaving the TUI.

[![CI](https://github.com/eugen1763/Pum/actions/workflows/ci.yml/badge.svg)](https://github.com/eugen1763/Pum/actions/workflows/ci.yml)
[![npm beta](https://img.shields.io/npm/v/pum-agent/beta?label=npm%20beta)](https://www.npmjs.com/package/pum-agent)
[![License: MIT](https://img.shields.io/github/license/eugen1763/Pum)](LICENSE)
[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun-f9f1e1?logo=bun&logoColor=14151a)](https://bun.sh)

</div>

## Quick start

```bash
bun i -g pum-agent@beta
pum
```

PUM opens the login panel automatically on the first start. Press `?` on an
empty prompt to see every control.

Select a model in `Ctrl+P`. GPT-6 Astra is listed for OpenAI and Codex;
using it requires access on your provider account. Press `r` in the model
list to refresh providers that support catalog discovery.

Use `/model <name or provider/model-id> [effort]` to change the main-agent model.
Names and IDs match exactly, without case sensitivity. Display names can contain spaces.
Use the provider-qualified ID when a name matches more than one model.
`/model` opens the model picker. `/effort <level>` changes only reasoning effort.
`/effort` shows the current effort and supported levels.
Both commands autocomplete available values and reject unsupported efforts before changing the model.
Model and effort changes use the same authentication and persistence as Settings.
Run these commands from the main transcript while the agent is idle; child models remain unchanged.
Use `/store` or `/s` to save current settings as global defaults, exactly like `s` in Settings.
These aliases promote PUM settings and clear session overrides. Pi already persists model and effort separately.

> [!WARNING]
> PUM can read, write, and delete files. Check mode adds deterministic policy
> checks, and supported hosts can enforce native Bash isolation, but the
> file-tool sandbox is a process-local path guard, not operating-system
> isolation. Read [Safety](docs/security.md) before using untrusted workspaces.

![PUM working on a theme change: grouped file reads, a syntax-highlighted patch diff, a subagent message, and the goal label on the rule above the prompt](docs/images/pum-transcript.svg)

<details>
<summary><strong>Settings panel</strong></summary>

![PUM's settings panel, showing appearance, agent, and safety settings](docs/images/pum-settings.svg)

</details>

<details>
<summary><strong>Controls panel</strong></summary>

![PUM's controls panel, showing prompt, agent, session, command, and application shortcuts](docs/images/pum-controls.svg)

</details>

These are real OpenTUI renders, not mockups. `bun run scripts/capture-screenshots.tsx`
drives the actual TUI and converts the captured cells to SVG.

## What it does

- **A full coding loop** — `read`, `write`, `edit`, and `bash`, with streaming Markdown, syntax highlighting, usage, cost, and Git status.
- **Parallel subagents** — persistent agents that share the project by default, with optional isolated Git worktrees. They message each other durably and report to their spawner. See [Subagents](docs/subagents.md).
- **Goals that outlive a turn** — `/goal` keeps working, reviewed after each turn by a judge that reads but never writes. See [Goals](docs/goals.md).
- **Project memory across sessions** — the main agent maintains private Markdown facts that follow linked Git worktrees. See [Tools](docs/tools.md#project-memory).
- **Supervised processes** — background shells and external triggers such as `gh run watch`, which wake the exact agent that was waiting. See [Tools](docs/tools.md).
- **Layered safeguards** — a path guard on the file tools, deterministic Check mode, and a native OS sandbox for the processes the model starts. See [Safety](docs/security.md).
- **A terminal-first look** — nine themes, semantic colour overrides, and optional animation. See [Appearance](docs/appearance.md).

PUM uses [pi](https://github.com/earendil-works/pi) for the agent loop and
[OpenTUI](https://github.com/anomalyco/opentui) for rendering.

## Documentation

| Guide | Contents |
|---|---|
| [Command line](docs/cli.md) | Options, headless runs, sandboxed launches, environment |
| [Controls](docs/controls.md) | Keys, slash commands, shell command mode, copying, News |
| [Goals](docs/goals.md) | `/goal`, the judge, retries, stopping |
| [Subagents](docs/subagents.md) | Spawning, merging, previews, readonly children |
| [Tools](docs/tools.md) | Tool groups, patches, questionnaires, triggers, shells, todos |
| [Safety](docs/security.md) | Filesystem sandbox, Check mode, native sandbox, outer sandbox |
| [Appearance](docs/appearance.md) | Transcript detail, themes, Markdown, animation, title |
| [Configuration](docs/configuration.md) | Where PUM stores things, and what |
| [Request diagnostics](docs/request-diagnostics.md) | Opt-in safe request reports; transport signals are not server cache hits |

## Requirements

- [Bun](https://bun.sh) — PUM runs on Bun, not Node
- Git
- An interactive terminal with ANSI/VT and Unicode support
- Credentials for a supported provider, or an OpenAI-compatible endpoint

Linux and macOS are the primary environments. Windows CI checks the code and
Windows path behaviour, but native Windows TUI operation is provisional.

Native Bash sandboxing is optional and platform-specific: on Linux it needs
Bubblewrap (`bwrap`) with working unprivileged user namespaces, which PUM probes
by launching a minimal sandbox rather than by finding the executable; on Windows
it uses the alpha `@microsoft/mxc-sdk` and its `base-container` tier. On Windows,
also install Git for Windows, keep `bash.exe` on `PATH`, and use Windows
Terminal with PowerShell — not PowerShell ISE.

## Install from source

```bash
git clone https://github.com/eugen1763/Pum.git
cd Pum
bun install --frozen-lockfile
bun run login
bun run start
```

Use `bun run start -r` to resume the latest session for the current directory,
and `/login` to add or update a provider later.
Inside the TUI, `/history` or its alias `/resume` opens the saved-session browser.
For local request debugging, start with `PUM_REQUEST_DIAGNOSTICS=1 bun run start`
and use `/diagnostics` in the selected transcript. Headless runs emit the safe
report on stderr only. Diagnostics stay in bounded process memory, not session
files, and do not establish provider cache hits. See [Request diagnostics](docs/request-diagnostics.md).

Agents have separate context tools: `history` searches and reads the active session
transcript. `get_context_remaining` reports the context budget. `new_context`
requests a rollover, deferred until the entire tool batch succeeds. Rollover keeps
the canonical session ID, session file, and full entries across resume. The agent
can supply an optional literal handoff; rollover never generates a summary.
Automatic summarization is disabled in these runtimes. Rollover is explicit, not
automatic. Manual `/compress` is unchanged before the first rollover. With an
active PUM rollover boundary, the controller refuses `/compress` before native
summarization or authentication preflight. Use `new_context` instead; the complete
transcript remains available. These tools are available to main, headless, and
worker agents, including readonly workers, but not internal judges or AFK delegates.

`history` returns metadata-only reads for structural entries, so agents can follow
`parentId` links without exposing private custom data. History pages run
sequentially and account for prior history results in the same tool batch.

Only one PUM instance can own a saved session at a time. Close the owning
session before resuming it elsewhere. This also applies to headless runs,
managed agents, and worktree resume aliases. A locked history selection leaves
the current session unchanged. PUM automatically recovers locks from dead
processes when it can verify the owner. It never expires a live process lock.

The published package is called `pum-agent` because the bare `pum` name is
taken; the installed command is still `pum`. `npm i -g pum-agent` copies the
files, but `pum` then fails with `env: 'bun': No such file or directory` —
install Bun first.

## Development

```bash
bun install --frozen-lockfile
bun test
bun run typecheck
git diff --check
```

Run the TUI from the repository root with `bun run start`, and refresh the
README images with `bun run scripts/capture-screenshots.tsx`. Use a throwaway
`PUM_DIR` for local integration tests, and capture TUI output through `tmux`
rather than piping standard output. [AGENTS.md](AGENTS.md) holds the
architecture, the locked decisions, and the TUI test guidance.

## Release status

PUM `0.2` is in beta. Interfaces and persisted formats can still change before
the stable release. Review the release notes before upgrading sessions or custom
configuration.

## License

PUM is available under the [MIT License](LICENSE).
