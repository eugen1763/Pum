# PUM

A small coding agent that runs in your terminal.

PUM reads, writes, and edits files and runs shell commands in whatever directory
you start it from. It is built on [pi](https://github.com/earendil-works/pi) for
the agent loop and [OpenTUI](https://github.com/anomalyco/opentui) for the
interface. The whole thing is about 400 lines.

## Requirements

[Bun](https://bun.sh). OpenTUI's renderer needs it.

## Install

```bash
git clone https://github.com/eugen1763/Pum
cd Pum
bun install
```

## Log in

PUM keeps its own credentials, separate from pi's. Start PUM with no configured
provider and PUM opens the in-app login popup automatically.

```bash
bun run login
```

Use `/login` at any time to open the same popup. The popup lists every login
method from pi's provider registry, including OAuth, device-code, browser, and
API-key flows.

The Custom Provider option accepts an endpoint and API key. PUM probes the
OpenAI-compatible `/models` endpoint, writes `models.json` atomically, and stores
the key only in PUM's `auth.json`. PUM keeps entered values after a failed probe.

## Use it

```bash
bun run start        # new session in the current directory
bun run start -r     # pick up the most recent session here
```

| Key | Effect |
|---|---|
| `?` | On an empty prompt, show the controls |
| Tab | Open the cache, or move its selected item into the input |
| Shift+↑ / Shift+↓ | Extend the cache selection across multiple prompts |
| Enter, with a cache selection | Ask the main agent to coordinate worktree subagents and merge them |
| Shift+Tab | Cycle forward through main and subagent transcripts |
| Ctrl+Shift+Tab | Cycle backward through main and subagent transcripts |
| Delete | Remove the selected cache item and matching prompt history |
| Alt+Enter | Stash the current prompt without sending |
| Ctrl+Alt+Enter | Stash when the terminal reserves Alt+Enter |
| Alt+V | Attach an image from the graphical clipboard |
| Ctrl+Enter / Shift+Enter | Insert a new line |
| `\` then Enter | Insert a new line when modified Enter is unavailable |
| Enter | Send — or steer, if the agent is already working |
| ↑ / ↓ | Walk back through earlier prompts, and forward to what you were typing |
| Esc | Press twice within 2s to cancel the selected turn and restore the prompt |
| Ctrl+P | Settings — providers, models, checks, writing style, and appearance |
| Ctrl+C | Once warns, twice quits |

Model and check-model lists include a case-insensitive search field. Search
matches provider IDs, provider names, model IDs, and model names. Press `/` from
a model row to focus the search field.

A top bar carries the model, thinking level, git branch, token count, cost, and
how much of the context window is gone. While the agent works it grows a
spinner, a timer, and a colour sweep through the label.

The prompt editor wraps long lines and grows to eight visible rows. Additional
rows scroll inside the editor. Wrapping reserves two columns at the right edge.
The `❯` marker follows the cursor's visible row. Use Ctrl+Enter or Shift+Enter
to insert an explicit line break. If the terminal cannot report modified Enter,
type `\` and press Enter; PUM removes the `\` and inserts a line break.

While it is working the prompt reads `Steer…`. Anything you send then is
delivered once the current step's tool calls finish, so you can redirect the
agent without stopping it. Queued steering stays in a dim pending section at
the transcript bottom until pi inserts it into the next turn. Inter-agent
messages use the same pending behavior on the recipient transcript. Press Esc
twice within two seconds to cancel the selected agent. The first press shows a
temporary confirmation hint.

The main agent can start parallel subagents with `spawn_subagent`. Each subagent
gets a persistent pi session and a branch under `.pum/worktrees`. Completion
notices return to the main agent automatically. `finish_subagent` sends the sole
final completion notice after the agent status changes. `message_agent` routes
questions, blockers, and actionable intermediate messages between agents. It
does not send final completion reports.

PUM allows five active subagents. Only `starting` and `running` agents consume
an active slot. For follow-up implementation work, the main agent prefers a new
worktree subagent while a slot is available. At capacity, the main agent queues
related work to an appropriate running subagent through `message_agent`. This
uses the durable recipient-side message and steering queue. If no appropriate
recipient is clear, the main agent reports the capacity issue and keeps the task
pending for deliberate routing.

In the cache, hold Shift and use Up or Down to select a range. Enter sends the
selected prompts to the main agent as a worktree batch. The main agent can group
related prompts into one subagent and runs independent groups in parallel. Each
successful worktree merges when it settles. The main agent waits only for a
concrete dependency, conflict risk, or required integration order.

Shift+Tab and Ctrl+Shift+Tab switch the visible transcript. Input then goes to
the selected agent. The header shows the retained agent count and active agent.
The `worktree` tool supports create, list, status, merge, and remove actions.
`/worktree [name]` creates one directly and persists a synthetic tool row.
A successful merge of a managed subagent automatically closes that agent,
removes its worktree, deletes its branch, and removes it from the transcript list.
An unmerged finished agent remains available for review or more prompts.

When PUM exits, worktrees and subagent session files remain on disk. A running
subagent becomes `interrupted` when the parent session resumes with `-r`.
Finished and interrupted subagents can receive more prompts after resume. A new
parent session does not adopt subagents from another parent session.

Alt+V reads an image from the Wayland or X11 clipboard and stores it in a
temporary PUM directory. The input shows `[Image #1]`, `[Image #2]`, and so on.
Editing any character inside a marker removes the complete marker and deletes
its temporary file. Sent images are converted to pi image attachments and the
temporary files are removed.

Every glyph is plain Unicode from common blocks — no Nerd Font, no patched
font. Emoji in a model's *answer* are a different matter: those come from the
model, and rendering them is up to your terminal font.

Answers render as markdown while they stream — headings, bold, lists,
blockquotes, tables, and fenced code with syntax highlighting. A blinking caret
stays at the end without changing the transcript layout.

Highlighting is tree-sitter, and PUM ships the parsers OpenTUI bundles:
JavaScript, TypeScript, Zig and Markdown. A fence in any other language still
renders as a tidy code block, just without colour.

## Web search

With a Codex subscription, PUM adds OpenAI's hosted `web_search` tool to
requests, so the model can look things up. It is on by default and can be
switched off in Ctrl+P.

Searches appear in the transcript like any other tool, with the query the model
actually issued, and are restored when you resume a session with `-r`:

```
web_search · site:github.com/oven-sh/bun/releases latest Bun release    ✓
```

It only applies to Codex models: pick an Anthropic model and it quietly does
nothing, which the settings row tells you.

## Writing style

Ctrl+P has a `Writing style` setting with two options:

- `none` — do not add writing-style instructions.
- `STE` — inject practical ASD-STE100 Simplified Technical English guidance
  into the system prompt before each agent run.

The STE option applies to explanatory text. It preserves code, commands, paths,
identifiers, quoted text, and required project terminology. It is writing
guidance, not a formal STE compliance checker or ASD certification.

## Check mode

Ctrl+P can enable `Check mode` and select a `Check model`. The default verifier
is `deepseek/deepseek-v4-flash`. Before each `bash` or `edit` call, PUM sends the
verifier only the working directory, tool name, and proposed tool input.

The verifier must return a clear `SAFE` decision. PUM blocks the tool call when
it returns `UNSAFE`, gives an unclear response, is unavailable, times out, or
fails.

PUM caches explicit `SAFE` decisions for a small set of simple, read-only Git
inspection commands. A cache hit requires the same working directory, verifier
model, and complete `bash` input, including fields such as `timeout`. PUM never
caches `edit` checks or rejected, failed, malformed, timed-out, or aborted
checks. The cache holds at most 256 entries.

The cache policy treats recognized built-in Git inspection operations as
safety-stable across repository-content changes. PUM does not cache project
scripts, shell composition, output-writing options, or explicit helper options.
Those operations can change safety when mutable project files or configuration
change. A missing, corrupt, or unwritable cache becomes a cache miss, so PUM
uses the verifier and stays fail-closed.

Check mode is off by default. It is a lightweight extra gate, not a replacement
for process isolation or a sandbox.

## Theming

Nine presets ship — `tokyonight`, `gruvbox`, `catppuccin`, `nord`, `dracula`,
`rosepine`, `solarized`, `kanagawa`, and `github-light` — switchable from
Ctrl+P. To change individual colours, drop a `theme.json` in the config
directory; it overrides whichever preset is active, and you only need the
tokens you care about:

```json
{ "accent": "#ff7a93", "userBg": "#2a2f45" }
```

The agent has four built-in coding tools: `read`, `write`, `edit`, and `bash`.
PUM also adds subagent communication and worktree tools. **Coding tools run
without asking.** Start PUM somewhere you are happy for it to make changes.

## Where things live

Everything sits under `~/.config/pum` — set `PUM_DIR` to move it.

| | |
|---|---|
| `auth.json` | Provider credentials, including custom-provider keys |
| `models.json` | Custom provider endpoints and discovered models; no submitted keys |
| `settings.json` | Model and thinking level, saved as you change them |
| `pum.json` | Theme, animations, web search, writing style, thinking traces |
| `check-mode-cache.json` | Up to 256 accepted read-only Git `bash` checks |
| `theme.json` | Optional colour overrides |
| `history.json` | Prompt history, one list per working directory |
| `prompt-stash.json` | Saved prompt stash, one list per working directory |
| `sessions/` | Main conversation history, one file per session |
| `subagents/` | Persistent subagent sessions grouped by parent session |

## Hacking on it

See [AGENTS.md](AGENTS.md) for the layout, the decisions behind it, and the
handful of OpenTUI and pi behaviours worth knowing before you change anything.

## License

[MIT](LICENSE).
