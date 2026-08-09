<div align="center">

# PUM

**A compact coding agent for the terminal.**

Plan, edit, run commands, review Markdown, and coordinate parallel Git worktrees without leaving the TUI.

[![CI](https://github.com/eugen1763/Pum/actions/workflows/ci.yml/badge.svg)](https://github.com/eugen1763/Pum/actions/workflows/ci.yml)
[![npm beta](https://img.shields.io/npm/v/pum-agent/beta?label=npm%20beta)](https://www.npmjs.com/package/pum-agent)
[![License: MIT](https://img.shields.io/github/license/eugen1763/Pum)](LICENSE)
[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun-f9f1e1?logo=bun&logoColor=14151a)](https://bun.sh)

</div>

## Quick Start

```bash
bun i -g pum-agent@beta
pum
```

PUM opens the login panel automatically on the first start.

> [!WARNING]
> PUM can read, write, and delete files. PUM can also run commands and supervised trigger processes. Check mode can verify or ask about these operations, but it is not a sandbox. Start PUM only inside a workspace where these actions are acceptable.

## See PUM in action

The following screens are real OpenTUI renders captured through `tmux`. A local mock provider supplied the model output.

![PUM transcript showing Markdown and a read tool call](docs/images/pum-transcript.svg)

<details>
<summary><strong>Settings panel</strong></summary>

![PUM settings panel](docs/images/pum-settings.svg)

</details>

## Why PUM

- **Compact terminal UI:** Streaming Markdown, syntax highlighting, thinking traces, tool rows, usage, cost, and Git status.
- **Full coding loop:** Built-in `read`, `write`, `edit`, `bash`, and atomic `apply_patch` tools.
- **Parallel subagents:** Persistent agents work in isolated Git worktrees, communicate durably, and report lifecycle transitions to their direct spawners.
- **Prompt control:** Steer active work, answer model questionnaires, use an ownership-aware message cache, attach clipboard images, and resume sessions with metadata-rich history.
- **External triggers:** Supervise background commands such as `gh run watch` and automatically wake the exact target agent when they exit.
- **Provider choice:** Use the login methods exposed by pi, or add an OpenAI-compatible custom endpoint.
- **Optional safeguards:** Use strict, balanced, or ask Check mode for `bash`, `edit`, `apply_patch`, and external-trigger process proposals.
- **Terminal-first appearance:** Nine themes, semantic color overrides, Unicode glyphs, and optional animation.

PUM uses [pi](https://github.com/earendil-works/pi) for the agent loop and [OpenTUI](https://github.com/anomalyco/opentui) for rendering.

## Requirements

- [Bun](https://bun.sh)
- Git
- An interactive terminal with ANSI/VT and Unicode support
- Credentials for a supported provider, or an OpenAI-compatible endpoint

Linux and macOS are the primary environments. Windows CI checks the code and Windows path behavior. Native Windows TUI operation remains provisional because it has not been fully validated in a Windows terminal.

On Windows, install Git for Windows. Ensure that `bash.exe` is in `PATH` or remains in its standard location. Use Windows Terminal with PowerShell. Do not use PowerShell ISE.

## Install and start

### Install from source

```bash
git clone https://github.com/eugen1763/Pum.git
cd Pum
bun install --frozen-lockfile
bun run login
bun run start
```

PUM opens the login panel automatically when no provider is available. Use `/login` later to add or update a provider.

Resume the latest session for the current directory:

```bash
bun run start -r
```

### Install the beta package

```bash
bun i -g pum-agent@beta
pum
```

The package is named `pum-agent` because the bare `pum` name is already owned. The installed command is still `pum`.

## Command-line options

```text
pum [options]
pum login [options]
```

| Option or command | Action |
|---|---|
| `-h`, `--help` | Print the command-line manual and exit |
| `-v`, `--version` | Print the exact `pum-agent` package version and exit |
| `-r`, `--resume` | Resume the latest session for the current directory |
| `login` | Start PUM with the provider login panel open |

Help and version handling do not initialize the TUI, configuration, credentials, or sessions. Unknown options and commands return an error and a help hint.

Set `PUM_DIR` to override PUM's complete configuration and data directory. Run `pum --help` for a concise directory summary. Enter `?` on an empty in-app prompt to see all controls.

## Essential controls

| Key | Action |
|---|---|
| `Enter` | Send a prompt, or steer the selected working agent |
| `↑` on an empty prompt | Recall the newest queued user message for the selected agent |
| `Ctrl+Enter` / `Shift+Enter` | Insert a new line |
| `Alt+Enter` | Stash the prompt without sending |
| `Tab` | Open the prompt stash on an empty input |
| `Shift+↑` / `Shift+↓` | Select a range of stashed tasks |
| `Alt+V` | Attach an image from the graphical clipboard |
| `Ctrl+L` | Open the agent transcript selector |
| `Shift+Tab` / `Ctrl+Shift+Tab` | Cycle through agent transcripts |
| `Ctrl+H` | Open session history when the terminal reports the key distinctly |
| `Ctrl+P` | Open settings |
| `Ctrl+T` | Open supervised external triggers |
| `Esc` twice | Cancel the selected working agent |
| `Ctrl+C` | Clear the selected non-empty draft; on an empty draft, press twice to quit |
| `?` | Show all controls when the prompt is empty |

Useful commands include `/login`, `/history`, `/triggers`, `/clear`, `/compress`, and `/worktree`.

## Parallel subagents

PUM runs up to 10 active subagents by default. Configure a limit from 1 through 25 in Settings. Only starting and running agents count toward the limit. Each subagent has these resources:

- A persistent pi session
- An isolated branch and worktree under `.pum/worktrees`
- Its own transcript, draft, usage data, and cancellation state
- Tools for progress messages and a single final completion report

Select a range of stashed prompts and press `Enter`. The main agent can group related work and run independent groups in parallel. Successful managed merges remove the completed worktree and branch. A parent cannot finish, merge, or be removed until every retained descendant closes deepest-first.

Use `Ctrl+L` to select an agent transcript. Input then goes to that agent. Finished or interrupted agents remain available until PUM merges or removes them.

The public `spawn_subagent` tool accepts `preview: true`. PUM then shows the exact child task before it creates any worktree or session. Press `Enter` to approve. An optional note becomes a separate visible user instruction to the new child. Press `Esc` to cancel without creating a child. Cancellation discards the preview note because no child exists. PUM preserves the existing parent transcript draft.

Press `↑` on an empty single-line prompt to recall the newest queued user-authored message for the selected transcript. PUM removes the message from the authoritative queue before restoring its text. PUM does not recall inter-agent, trigger, lifecycle, cache, delivered, or image-bearing messages.

Idle notices report settled work cycles to the direct spawner. They are not completion notices. PUM persists completion intent and delivery state so interrupted notification delivery can resume without duplicate completion messages.

## Tools and safeguards

### Interactive questionnaires

The `questionnaire` tool asks one or more questions inside PUM's OpenTUI interface. Each question provides selectable options and a custom-answer field. Use arrow keys or `Tab` to move, `Enter` to select, and `Esc` to cancel.

PUM returns structured answers to the requesting main agent or managed child agent. Custom text stays outside React labels and session data until the user explicitly submits the answer.

### Agent message cache

Main and managed child agents can list and read the current workspace message cache. Agent-created entries include exact ownership metadata.

Agents can add entries. An agent can delete only entries created by that exact agent. User-created and legacy entries remain user-owned.

The `message_cache_send` tool accepts stable entry IDs. Single entries use the selected agent delivery path. Multiple entries use main-agent worktree orchestration.

### External triggers

The trigger tools create process-local supervised commands with an executable and argument array. Trigger definitions can be listed, inspected, paused, resumed, cancelled, or run manually. Definitions disappear when PUM exits.

Use `Ctrl+T` or `/triggers` to inspect active definitions. PUM limits definitions, pending deliveries, output size, run counts, repeat frequency, and lifetime. Output goes to a private temporary file and is removed after the triggered turn settles.

Trigger events target one exact main or retained child session. A missing session or child cancels its definitions instead of redirecting them. Check mode evaluates each process proposal without flattening its argument boundaries into shell text.

### Atomic `apply_patch`

`apply_patch` supports add, update, delete, move, multiple files, and multiple hunks. PUM validates the full patch before changing files. It rejects traversal, absolute paths, escaping symlinks, path conflicts, and ambiguous context. A failed commit restores all touched files.

### Check mode

Select a Check mode profile in `Ctrl+P`. It applies to `bash`, `edit`, `apply_patch`, and external-trigger process execution:

- **Strict:** Run deterministic hard rules, then require a clear verifier approval.
- **Balanced:** Block deterministic hard-rule or suspicious findings. Allow ordinary complete project-local calls. Verifier review is non-blocking unless the verifier returns explicit `UNSAFE`.
- **Ask:** Show the approval popup for every checked call that passes hard rules, unless an exact session or project approval already matches. A verifier `SAFE`, unclear, error, or unavailable result still requires approval.

Every active profile hard-blocks project escape, escaping links, credential access, privilege escalation, persistence, remote-script execution, destructive Git operations, and broad deletion. These hard blocks cannot be overridden and do not open the popup. An explicit verifier `UNSAFE` verdict also blocks without a popup. The only exception is a deterministic match for direct main-agent `npm publish` or `npm dist-tag add`. The verifier category does not control this exception. The exception still requires explicit popup approval. Managed subagents cannot use the exception.

For `edit` and `apply_patch`, PUM validates the complete proposed change before any mutation. Review data includes the unified diff, changed paths, line counts, sensitivity flags, project containment, and full-content SHA-256. Invalid, stale, malformed, escaping, or incompletely analyzed input blocks the call. Patch length alone does not block a valid Balanced call.

Ask mode can allow an exact call once, for the current session, or for the current project. Approvals match the authoritative main or child identity, tool, verifier model, project, and canonical complete input. Chat text is not approval. Use **Clear approvals** in Settings to remove project approvals.

The verifier uses a structured decision schema. One unclear response can receive one adjudication under the shared 15-second watchdog. Strict blocks malformed replies, errors, aborts, and timeouts. Balanced allows a fully validated call after an unclear, unavailable, failed, or timed-out review. Balanced still blocks explicit verifier `UNSAFE`, aborts, deterministic suspicious findings, malformed structures, and incomplete analysis. Ask requires the popup after hard rules for verifier `SAFE`, unclear, error, and unavailable results. Check mode is off by default and is not a sandbox.

Verifier prompts stay bounded. For an oversized Balanced review, PUM sends complete validation metadata, counts, findings, and SHA-256 digests. PUM does not send a raw prefix or suffix as if it were complete. Strict and Ask keep their fail-closed oversized-input behavior.

### Hosted web search

Web search is on by default for supported OpenAI Codex providers. Searches appear as transcript tool rows and persist in resumed sessions. Other providers continue without the hosted search tool. Disable web search in `Ctrl+P`.

### Themes and Markdown

PUM includes `tokyonight`, `gruvbox`, `catppuccin`, `nord`, `dracula`, `rosepine`, `solarized`, `kanagawa`, and `github-light`. Select a preset in `Ctrl+P`.

Create `theme.json` in the PUM config directory to override semantic tokens:

```json
{
  "accent": "#ff7a93",
  "userBg": "#2a2f45"
}
```

Markdown renders while streaming. OpenTUI provides syntax parsers for JavaScript, TypeScript, Zig, and Markdown. Other fenced languages still render as code blocks without syntax colors.

## Configuration and data

Set `PUM_DIR` to override the complete PUM data directory.

| Platform | Default directory |
|---|---|
| Linux | `$XDG_CONFIG_HOME/pum` or `~/.config/pum` |
| macOS | `~/Library/Application Support/pum` |
| Windows | `%LOCALAPPDATA%\pum`, with `%APPDATA%\pum` as fallback |

| Path | Purpose |
|---|---|
| `auth.json` | Provider credentials and custom-provider keys |
| `models.json` | Custom endpoints and model metadata; submitted keys are not stored here |
| `settings.json` | Model and thinking level managed by pi |
| `pum.json` | Theme, animation, search, writing, explanation, and check settings |
| `theme.json` | Optional semantic color overrides |
| `history.json` | Prompt history by working directory |
| `prompt-stash.json` | Stashed prompts by working directory |
| `sessions/` | Main conversation sessions |
| `subagents/` | Persistent subagent sessions |
| `check-mode-cache.json` | Accepted checks for eligible read-only Git commands |
| `check-mode-approvals.json` | Exact project approvals created in Ask mode |

PUM preserves all stashed prompt occurrences. PUM also keeps the 100 most recent additional sent-history occurrences for each working directory.

Session history shows the latest sent user-message time, on-disk JSONL size, and known outgoing, incoming, and cache-read token counts. Corrupt or partially written session lines do not prevent the history popup from opening.

PUM keeps this directory separate from pi's default configuration directory.

## Development

```bash
bun install --frozen-lockfile
bun test
bun run typecheck
git diff --check
```

Run the TUI from the repository root:

```bash
bun run start
```

Use a throwaway `PUM_DIR` for local integration tests. Capture TUI output through `tmux`; do not pipe standard output. See [AGENTS.md](AGENTS.md) for architecture, locked decisions, and TUI test guidance.

## Release status

PUM `0.1` is in beta. Interfaces and persisted formats can still change before the stable release. Review the release notes before upgrading sessions or custom configuration.

## License

PUM is available under the [MIT License](LICENSE).
