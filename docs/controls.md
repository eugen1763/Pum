# Controls

[← Back to the README](../README.md)

Press `?` on an empty prompt to see every control inside PUM.

| Key | Action |
|---|---|
| `Enter` | Send or steer; while input mode is on, insert a new line |
| `!` on an empty prompt | Enter shell command mode and run a command yourself |
| `Alt+I` | Toggle multiline input mode; the prompt gutter changes to `i` while active |
| `↑` on an empty prompt | Recall the newest queued user message for the selected agent |
| `Ctrl+Enter` / `Shift+Enter` | Insert a new line |
| `Alt+Enter` / `Ctrl+Alt+Enter` | Cache without sending; the Ctrl alias works around terminals that reserve Alt+Enter |
| `Tab` | Open the prompt cache on an empty input; complete commands or paths otherwise |
| `↑` / `↓` on suggestions | Move through every match; the list shows five rows and scrolls |
| `Shift+↑` / `Shift+↓` | Select a range of cached tasks |
| `Alt+V` | Attach an image from the graphical clipboard |
| `Ctrl+L` | Open the agent transcript selector |
| `Shift+Tab` / `Ctrl+Shift+Tab` | Cycle through agent transcripts |
| `Ctrl+H` | Open session history when reported distinctly; use `/history` otherwise |
| `Ctrl+N` | Open recent answers (News) |
| `Ctrl+O` | Open the selected agent's todo list |
| `Ctrl+End` | Scroll to the end of the selected transcript |
| `Ctrl+P` | Open settings |
| `Ctrl+T` | Open Processes for supervised triggers and shells |
| `Esc` twice | Cancel the selected working agent, which also stops an active goal |
| `Ctrl+C` | Close the active popup, or clear a non-empty draft; on an empty prompt, press twice to quit |
| `?` | Show all controls when the prompt is empty |

Sent-prompt history with `↑` / `↓` is available in the main transcript. Wrapped
or multiline drafts keep those keys for cursor movement. Subagent views still
support empty-prompt queued-message recall.

## Commands

| Command | Action |
|---|---|
| `/goal <text>`, `/goalf <draft>` | Set an autonomous goal, or work one out first. See [Goals](goals.md) |
| `/afk [instructions]` | Answer questionnaires while you are away |
| `/background <prompt>` | Start a shared-project agent owned by the selected transcript |
| `/todo` | Open the selected agent's todo list |
| `/news` | Recent answers |
| `/history` | Session history |
| `/processes`, `/triggers` | Supervised processes; `/triggers` opens that tab |
| `/worktree` | Move the running session into a worktree and back |
| `/settings [name] [value]` | Show or change any `pum.json` setting. See [Configuration](configuration.md) |
| `/check-path` | Manage additional Check mode roots |
| `/checkpoint [list\|recover <id>\|clear]` | List runtime file checkpoints, create a recovery copy, or discard checkpoints |
| `/compress`, `/clear`, `/new` | Compact the context, or start fresh |
| `/stats` | Usage and cost for the session |
| `/login` | Add or update a provider |
| `/providers` | Manage providers: `/providers [add\|edit\|delete] [name]` |

## File checkpoint recovery

Type `/checkpoint` (or `/checkpoint list`) directly in the TUI prompt to inspect
checkpoints for the selected main or retained worker session. The list includes
IDs, tool names, paths, prior absence, and the runtime's scope, limits, and skip
counts. Checkpoints are runtime-only, not durable backups or a general undo log.

`/checkpoint recover <id>` requires the selected session to be idle. It writes a
**new recovery copy**, never restores or deletes the original path. Inspect the
returned copy and apply it manually if wanted. A previously absent file has no
old content to recover. User keyboard transitions pause while the copy is being
created. `/checkpoint clear` discards this runtime's retained checkpoints without
changing original files.

These commands are explicit user actions only, not model tools or extension slash
commands. Attached images and pasted-text markers do not authorize recovery.
Reports stay in the UI rather than entering model context or the durable transcript.

## Providers

`/providers` opens a list of every provider PUM knows, with its state: logged
in, not logged in, and whether it is custom. Use the subcommands to skip the
list.

| Command | Effect |
| --- | --- |
| `/providers` | Open the list |
| `/providers add` | Open the login picker, the same as `/login` |
| `/providers add <name>` | Log in to one provider |
| `/providers edit <name>` | Re-authenticate a provider, or change a custom endpoint |
| `/providers delete <name>` | Remove a provider, after a confirmation |

In the list, `↑↓` move, `Enter` adds or re-authenticates, `d` deletes, `/`
focuses the filter, and `Esc` closes. The subcommand and the provider name both
complete with `Tab`.

Deletion removes different things for the two kinds of provider:

- A built-in provider loses its stored credential only. It stays in the list,
  and you can add it again.
- A custom provider also loses its definition from `models.json`, so it leaves
  the list.

Deletion always asks first. A provider that holds no credential and has no
custom definition cannot be deleted, and PUM says so.

## Shell command mode

`!` on an empty prompt switches the prompt to a shell command: the `!` never
enters the command, the gutter shows it instead, and both input rules take the
accent colour. Backspace or `Esc` on an empty command returns to the normal
prompt.

The command runs with PUM's own Bash operations. Check mode does not inspect a
command you typed yourself — you are the approval — but the configured native
sandbox still applies. The result joins the session, so a running agent takes it
as a steer and an idle one starts a turn with it in context.

## Copy transcript text

Drag across transcript text with the left mouse button. PUM copies the completed
selection when you release the button.

- On local Windows, PUM first uses the native clipboard module, then `clip.exe`.
- On local macOS, PUM first uses the native clipboard module, then `pbcopy`.
- On local Linux, PUM tries `wl-copy`, `xclip`, or `xsel` when the matching display is available.
- Over SSH or Mosh, PUM sends OSC 52 through OpenTUI, which wraps it for detected `tmux` sessions.

Windows Terminal accepts OSC 52 from remote sessions, and can still ask for
clipboard-write approval. For `tmux`, enable clipboard integration and
passthrough when the server configuration blocks OSC 52:

```tmux
set -g set-clipboard on
set -g allow-passthrough on
```

Reload the `tmux` configuration afterwards. Use the terminal's Shift-drag
selection as a manual fallback. PUM limits remote OSC 52 payloads to 100,000
Base64 characters, so a large selection cannot corrupt terminal output.

## Recent answers (News)

Open News with `Ctrl+N` or `/news`. It lists the final answers of user-initiated
turns, newest first, each with the prompt and any follow-up steers that produced
it.

| Key | Action |
|---|---|
| `←` / `→` | Move between answers |
| `n` / `p` | Jump to the answer / to the source prompt |
| `Space` | Toggle read and unread |
| `c` | Copy the current answer |
| `Enter` | Reply with a quoted draft |
| `Esc` | Close |

An answer is marked read automatically only when a new user prompt follows it
directly. If anything else appears in between — a subagent message, a trigger
event, a queued message, an in-progress stream — it stays unread.
