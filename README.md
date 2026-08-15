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
> PUM can read, write, and delete files. Check mode adds deterministic policy checks, and supported hosts can enforce native Bash isolation. The file-tool sandbox is a process-local path guard, not complete operating-system isolation. Review the safeguards before using untrusted workspaces.

## See PUM in action

The following screens are real OpenTUI renders captured through `tmux`. A local mock provider supplied the model output.

![PUM transcript showing Markdown and a read tool call](docs/images/pum-transcript.svg)

<details>
<summary><strong>Settings panel</strong></summary>

![PUM settings panel](docs/images/pum-settings.svg)

</details>

## Why PUM

- **Compact terminal UI:** Streaming Markdown, syntax highlighting, thinking traces, tool rows, usage, cost, launch directory, and Git status.
- **Full coding loop:** Built-in `read`, `write`, `edit`, `bash`, and atomic `apply_patch` tools.
- **Parallel subagents:** Persistent agents work in isolated Git worktrees, communicate durably, and report lifecycle transitions to their direct spawners.
- **Prompt control:** Steer active work, answer model questionnaires, use an ownership-aware message cache, attach clipboard images, and resume sessions with metadata-rich history.
- **External triggers:** Supervise background commands such as `gh run watch` and automatically wake the exact target agent when they exit.
- **Provider choice:** Search the providers exposed by pi, or add an OpenAI-compatible custom endpoint.
- **Filesystem boundary:** `read`, `write`, and `edit` stay inside the project and configured allowed roots. `apply_patch` stays project-local.
- **Optional safeguards:** Turn on Check mode to gate `bash`, `edit`, `apply_patch`, and external-trigger process proposals. Supported hosts can also use native Bash sandboxing through Bubblewrap or Windows CreateProcessInSandbox.
- **Terminal-first appearance:** Nine themes, semantic color overrides, Unicode glyphs, and optional animation.

PUM uses [pi](https://github.com/earendil-works/pi) for the agent loop and [OpenTUI](https://github.com/anomalyco/opentui) for rendering.

## Requirements

- [Bun](https://bun.sh)
- Git
- An interactive terminal with ANSI/VT and Unicode support
- Credentials for a supported provider, or an OpenAI-compatible endpoint

Linux and macOS are the primary environments. Windows CI checks the code and Windows path behavior. Native Windows TUI operation remains provisional because it has not been fully validated in a Windows terminal.

On Linux, native Bash sandboxing requires Bubblewrap (`bwrap`) and working unprivileged user namespaces. PUM probes a minimal sandbox launch; finding the executable alone is not sufficient. On Arch Linux, install the prerequisite separately with `sudo pacman -S --needed bubblewrap`.

On Windows, install Git for Windows. Ensure that `bash.exe` is in `PATH` or remains in its standard location. Use Windows Terminal with PowerShell. Do not use PowerShell ISE. Native Bash sandboxing uses the optional alpha `@microsoft/mxc-sdk` package and requires its `base-container` CreateProcessInSandbox tier. PUM deliberately rejects the SDK's AppContainer+DACL fallback because it can modify host ACLs.

### Terminal title

PUM sets a compact terminal title such as `Pum · working · 2 subagents`. The title reports overall activity and counts only starting or running subagents. PUM clears the title during graceful shutdown.

Windows Terminal and common Linux terminal emulators accept the title through OpenTUI. Inside `tmux`, PUM sets the active pane title. To copy that pane title to the outer terminal title, add this configuration:

```tmux
set -g set-titles on
set -g set-titles-string '#T'
```

Keep `allow-set-title` enabled so applications can update the pane title. A `tmux` configuration can replace or suppress application titles. PUM cannot override that server policy.

## Install and start

### Install from source

```bash
git clone https://github.com/eugen1763/Pum.git
cd Pum
bun install --frozen-lockfile
bun run login
bun run start
```

PUM opens the login panel automatically when no provider is available. Use `/login` later to add or update a provider. During browser-based login, PUM opens credential-free HTTP(S) authentication URLs with the platform browser. The URL remains selectable when automatic launch is unavailable.

Custom OpenAI-compatible provider fields accept terminal bracketed paste and local `Ctrl+V` clipboard paste for endpoint URLs and API keys. PUM routes pasted API keys directly to the login controller and renders only a length mask. Remote sessions do not invoke a local host clipboard command.

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
pum s [login] [options] [directory[:ro|:rw] ...]
pum sr [login] [options] [directory[:ro|:rw] ...]
pum ss
```

| Option or command | Action |
|---|---|
| `-h`, `--help` | Print the command-line manual and exit |
| `-v`, `--version` | Print the exact `pum-agent` package version and exit |
| `-r`, `--resume` | Resume the latest session for the current directory |
| `login` | Start PUM with the provider login panel open |
| `s` | Start PUM in a writable outer `claudebox` sandbox |
| `sr` | Start PUM with the current directory read-only |
| `ss` | Check the `claudebox` runtime and protocol version |

Plain extra directories use the command default. Add `:ro` or `:rw` to select explicit access. `pum sr` always keeps the launch directory read-only, but it permits an explicit writable extra directory. A custom `PUM_DIR` must remain outside the project for `pum sr`.

Help, version, and sandbox setup checks do not initialize the TUI, credentials, or sessions. Unknown options and commands return an error and a help hint.

Set `PUM_DIR` to override PUM's complete configuration and data directory. Set `PUM_CLAUDEBOX` to select a specific `claudebox` executable. Run `pum --help` for a concise directory summary. Enter `?` on an empty in-app prompt to see all controls.

### Outer sandbox MVP

`pum s` and `pum sr` currently require Linux. On Windows, install PUM and `claudebox` inside WSL 2 and run the commands there.

PUM requires `claudebox` launcher protocol 1. Run `pum ss` to verify the executable and protocol. The runtime also needs `runsc`, `pasta`, `iptables`, `ip6tables`, `ip`, `nsenter`, and `unshare`.

The launcher hides the normal home mount. It mounts the project, explicit extra directories, the required PUM runtime files, and the PUM configuration directory. The sandboxed child uses the saved Check mode setting and disables nested Bubblewrap.

This MVP mounts the PUM configuration directory, including provider credentials, inside gVisor. When Check mode is on, it blocks credential access through supported tools, but it is not a second OS boundary. A host-side credential broker is planned for stronger separation.

## Essential controls

| Key | Action |
|---|---|
| `Enter` | Send or steer; while input mode is on, insert a new line |
| `Alt+I` | Toggle multiline input mode; the prompt gutter changes to `i` while active |
| `↑` on an empty prompt | Recall the newest queued user message for the selected agent |
| `Ctrl+Enter` / `Shift+Enter` | Insert a new line |
| `Alt+Enter` / `Ctrl+Alt+Enter` | Cache without sending; the Ctrl alias works around terminals that reserve Alt+Enter |
| `Tab` | Open the prompt cache on an empty input |
| `Shift+↑` / `Shift+↓` | Select a range of cached tasks |
| `Alt+V` | Attach an image from the graphical clipboard |
| `Ctrl+L` | Open the agent transcript selector |
| `Shift+Tab` / `Ctrl+Shift+Tab` | Cycle through agent transcripts |
| `Ctrl+H` | Open session history when reported distinctly; use `/history` otherwise |
| `Ctrl+N` | Open recent answers (News) |
| `n` / `p` in News | Jump to the answer / source |
| `Ctrl+End` | Scroll to the end of the selected transcript |
| `Ctrl+P` | Open settings |
| `Ctrl+T` | Open Processes for supervised triggers and shells |
| `Esc` twice | Cancel the selected working agent |
| `Ctrl+C` | Close the active popup, or clear a non-empty draft; on an empty prompt, press twice to quit |
| `?` | Show all controls when the prompt is empty |

Sent-prompt history with `↑` / `↓` is available in the main transcript. Wrapped or multiline drafts keep those keys for cursor movement. Subagent views still support empty-prompt queued-message recall.

Useful commands include `/login`, `/history`, `/news`, `/processes`, `/triggers`, `/check-path`, `/clear`, `/compress`, and `/worktree`. `/triggers` opens Processes directly on the Triggers tab.

For automated benchmarks, add `--statsFile <path>` to a headless `-p` run. PUM writes a versioned JSON artifact with run metadata and all `/stats` data. PUM creates missing parent directories. PUM rejects an existing file before startup unless `--override` is present. The alias `--stats-file` is also accepted.

### Copy transcript text

Drag across transcript text with the left mouse button. PUM copies the completed selection when you release the button.

- On local Windows, PUM first uses the native clipboard module. PUM then tries `clip.exe`.
- On local macOS, PUM first uses the native clipboard module. PUM then tries `pbcopy`.
- On local Linux, PUM tries `wl-copy`, `xclip`, or `xsel` when the matching display is available.
- Over SSH or Mosh, PUM sends OSC 52 through OpenTUI. OpenTUI wraps OSC 52 for detected `tmux` sessions.

Windows Terminal accepts OSC 52 from remote sessions. The terminal can still ask for clipboard-write approval.

For `tmux`, enable clipboard integration and passthrough when the server configuration blocks OSC 52:

```tmux
set -g set-clipboard on
set -g allow-passthrough on
```

Reload the `tmux` configuration after this change. Use the terminal's Shift-drag selection as a manual fallback.

PUM limits remote OSC 52 payloads to 100,000 Base64 characters. This limit prevents large selections from corrupting terminal output.

### Recent answers (News)

Open the News popup with `Ctrl+N` or `/news`. It lists the final answers of user-initiated turns, newest first. Each entry shows the user prompt and any follow-up steers that produced the answer, above the answer itself.

- `←` / `→` — move between answers
- `n` — jump to the answer
- `p` — jump to the source prompt or completion notice
- `Space` — toggle an answer between read and unread
- `c` — copy the current answer to the clipboard
- `Enter` — reply to the current answer with a quoted draft
- `Esc` — close the popup

PUM marks an answer read automatically only when a new user prompt follows it directly in the transcript. If anything else appears between the answer and the next prompt — a subagent message, a trigger event, a queued message, or an in-progress stream — the answer stays unread.

## Parallel subagents

PUM runs up to 10 active subagents by default. Configure a limit from 1 through 25 in Settings. Only starting and running agents count toward the limit. Each subagent has these resources:

- A persistent pi session
- An isolated branch and worktree under `.pum/worktrees`
- Its own transcript, draft, usage data, and cancellation state
- Tools for progress messages and a single final completion report

Select a range of cached prompts and press `Enter`. The main agent can group related work and run independent groups in parallel. A managed merge requires both authoritative `completed` status and a persisted completion notice. Idle settlement is not completion. Successful managed merges remove the completed worktree and branch. A parent cannot finish, merge, or be removed until every retained descendant closes deepest-first.

Use `Ctrl+L` to select an agent transcript. Input then goes to that agent. Finished or interrupted agents remain available until PUM merges or removes them.

The public `spawn_subagent` tool accepts `preview: true`. PUM then shows the exact child task before it creates any worktree or session. Press `Enter` to approve. An optional note becomes a separate visible user instruction to the new child. Press `Esc` to cancel without creating a child. Cancellation discards the preview note because no child exists. PUM preserves the existing parent transcript draft.

When the Sandbox setting is `Auto` or `Require`, `spawn_subagent` also accepts `readonly: true`. A readonly child can inspect files and run sandboxed inspection commands. PUM omits `write`, `edit`, `apply_patch`, child spawning, inter-agent delegation, process-starting trigger tools, and message-cache mutation tools from that child. The remaining tool guard blocks unknown or mutation-capable child paths. Worktree access is limited to `list` and `status`. Bash requires an enforced native sandbox, receives read-only project, `/check-path`, and managed Git metadata roots, and receives no network access. If native enforcement is unavailable, readonly Bash blocks instead of using the `Auto` direct fallback. PUM persists readonly state across resume. Sandbox `Off` removes the argument from live spawn tool schemas and rejects any explicit readonly spawn request.

Press `↑` on an empty single-line prompt to recall the newest queued user-authored message for the selected transcript. PUM removes the message from the authoritative queue before restoring its text. PUM does not recall inter-agent, trigger, lifecycle, cache, delivered, or image-bearing messages.

Idle notices report settled work cycles to the direct spawner. They are not completion notices. PUM acknowledges completion delivery only after the notice enters the parent session. Persisted completion intent and stable message identifiers let interrupted delivery resume without duplicate completion messages.

## Tools and safeguards

### Interactive questionnaires

The `questionnaire` tool asks one or more questions inside PUM's OpenTUI interface. Each question provides selectable options and a custom-answer field. Use arrow keys or `Tab` to move and `Enter` to select. `Esc` cancels from the option view; while editing a custom answer, it returns to the options.

PUM returns structured answers to the requesting main agent or managed child agent. Custom text stays outside React labels and session data until the user explicitly submits the answer.

### Agent message cache

Main and managed child agents can list and read the current workspace message cache. Agent-created entries include exact ownership metadata.

Agents can add entries. An agent can delete only entries created by that exact agent. User-created and legacy entries remain user-owned.

The `message_cache_send` tool accepts stable entry IDs. Single entries use the selected agent delivery path. Multiple entries use main-agent worktree orchestration. PUM reserves selected entries during delivery and marks them executed only after delivery succeeds. Failed main or child delivery leaves the entries pending.

### External triggers

The trigger tools create process-local supervised commands with an executable and argument array. Trigger definitions can be listed, inspected, paused, resumed, cancelled, or run manually. Definitions disappear when PUM exits.

Use `Ctrl+T` or `/processes` to open the combined Processes view. `/triggers` is an alias that opens its Triggers tab. PUM limits definitions, pending deliveries, output size, run counts, repeat frequency, and lifetime. Output goes to a private temporary file and is removed after the triggered turn settles.

Trigger events target one exact main or retained child session. A missing session or child cancels its definitions instead of redirecting them. Check mode evaluates each process proposal without flattening its argument boundaries into shell text.

### Atomic `apply_patch`

`apply_patch` supports add, update, delete, move, multiple files, and multiple hunks. PUM validates the full patch before changing files. It rejects traversal, absolute paths, escaping symlinks, path conflicts, and ambiguous context. A failed commit restores all touched files.

### Filesystem sandbox

The process-local filesystem sandbox validates `read`, `write`, `edit`, and `apply_patch` before execution.

- Project paths and `/check-path` roots are allowed.
- Credential-sensitive paths are blocked.
- Symbolic links and junctions in tool paths are blocked.
- `apply_patch` remains project-local and keeps its atomic validation.

This boundary does not isolate `bash`, package scripts, extensions, or trigger processes from the operating system. Use a container, VM, or policy-controlled sandbox for stronger isolation.

### Check mode

Select Check mode in `Ctrl+P` — either **Off** or **On**. It applies to `bash`, `edit`, `apply_patch`, and external-trigger process execution:

- **Off:** Checked tools run without the deterministic policy or the advisory verifier.
- **On:** The deterministic policy runs first, then an advisory verifier reviews the complete proposal.

On allows ordinary complete project-local calls, explicit on-mode external reads (read-only), and project-local edits. It accepts one direct `npm pack` only when lifecycle scripts are disabled, an explicit cache stays in an approved root, output stays in an approved root, and any package operand is one exact registry version. On also accepts one direct `npm install` of one exact registry version only when `--ignore-scripts`, an approved `--prefix`, and an approved `--cache` are explicit. File, Git, URL, tag, range, composed, general install, and global-install forms remain blocked. On hard-blocks external writes, location changes, execution operands, ambiguous path access, escaping links or junctions, credential access, privilege escalation, persistence, remote-script execution, destructive Git operations, and broad deletion. These hard blocks cannot be overridden and never open a popup.

On blocks an explicit verifier verdict of `UNSAFE`. An unclear, unavailable, failed, or timed-out review does not block a fully validated call. The only exception outside the verifier verdict is a deterministic match for a direct main-agent `npm publish` or `npm dist-tag add ... latest`, which On allows outright. The verifier category does not control this exception. Managed subagents cannot use it.

There is no approval popup and no approval store. Check mode is off by default.

Use `/check-path list`, `/check-path add <directory>`, `/check-path remove <directory>`, or `/check-path clear` to manage up to 16 additional directory roots for the current launch project. The filesystem sandbox applies these roots to `read`, `write`, and `edit`. Bash, edit, and external-trigger checks also use these roots; `apply_patch` remains project-local. Added roots are canonicalized and remain subject to credential, traversal, symlink or junction, broad-deletion, and other hard blocks.

For `edit` and `apply_patch`, PUM validates the complete proposed change before any mutation. Review data includes the unified diff, changed paths, line counts, sensitivity flags, project containment, and full-content SHA-256. Invalid, stale, malformed, escaping, or incompletely analyzed input blocks the call. Patch length alone does not block a complete validated on-mode call.

The verifier uses a structured decision schema. One unclear response can receive one bounded adjudication under the shared 15-second watchdog. On blocks aborts, malformed verifier replies, and incomplete analysis, and it blocks any explicit `UNSAFE` verdict. Check mode is off by default.

#### Native Bash sandbox

The **Sandbox** setting has three modes:

- **Auto:** Enforce the platform sandbox for Bash when available. If probing fails, retain deterministic Check mode and show one process-local warning that is not written to session context.
- **Require:** Block checked Bash calls unless native enforcement is available.
- **Off:** Do not sandbox Bash. Check mode policy and approval behavior remain unchanged.

Check mode **Off** always uses pi's normal unsandboxed Bash backend. For an active Check mode, PUM recomputes the sandbox policy from the exact approved command, authoritative working directory, configured additional roots, and deterministic access analysis. Model input cannot supply policy fields.

The project and configured additional roots are writable. Explicit on-mode external reads are mounted read-only. PUM configuration and common credential paths are denied, and credential-shaped or process-injection environment variables are removed. A private temporary directory is supplied for the command. Safe pi metadata such as `PI_PROVIDER`, `PI_MODEL`, and `PI_REASONING_LEVEL` remains available; session paths and identifiers are withheld.

Network access is denied unless deterministic analysis recognizes an approved network operation. Bubblewrap's host-network mode is all-or-nothing and is **not domain-filtered**. Windows similarly grants or withholds the SDK's broad network capabilities; it does not provide hostname allowlists.

The override uses pi's `createBashTool` implementation and custom Bash operations, preserving streaming, truncation, full-output files, rendering, timeout messages, abort handling, shell configuration, and child-tree cleanup. Only Bash commands are routed through this backend. PUM does not sandbox the TUI/model process itself.

External triggers preserve direct executable/argument boundaries and continue to use deterministic Check mode, but they are not routed through the native sandbox in this release. The trigger manager's synchronous spawn boundary does not carry the exact approved policy object into execution; silently recomputing a second process policy there would weaken approval identity. Trigger output, environment, limits, and process supervision remain unchanged.

The filesystem sandbox is a process-local path guard for `read`, `write`, `edit`, and `apply_patch`. It does not replace native Bash isolation and does not cover scripts, extensions, or trigger processes.

Verifier prompts stay bounded. For an oversized On-mode review, PUM sends complete validation metadata, counts, findings, and SHA-256 digests. PUM does not send a raw prefix or suffix as if it were complete.

### Hosted web search

Web search is on by default for supported OpenAI Codex providers. Searches appear as transcript tool rows and persist in resumed sessions. Other providers continue without the hosted search tool. Disable web search in `Ctrl+P`.

Setting **Output** to detailed adds a result preview under the tool row. Bash shows the last five lines of output, `write` shows the first thirty lines of the new file, and `edit` shows the patch. These limits are fixed; there is no setting for them.

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
| `pum.json` | Theme, animation, transcript output, search, writing, explanation, Check mode, sandbox, and subagent settings |
| `theme.json` | Optional semantic color overrides |
| `history.json` | Prompt history by working directory |
| `prompt-stash.json` | Cached prompts by working directory (legacy filename) |
| `sessions/` | Main conversation sessions |
| `subagents/` | Persistent subagent sessions |

PUM preserves all cached prompt occurrences. PUM also keeps the 100 most recent additional sent-history occurrences for each working directory.

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

PUM `0.2` is in beta. Interfaces and persisted formats can still change before the stable release. Review the release notes before upgrading sessions or custom configuration.

## License

PUM is available under the [MIT License](LICENSE).
