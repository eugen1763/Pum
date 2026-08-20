# Configuration and data

[← Back to the README](../README.md)

Set `PUM_DIR` to override the complete PUM data directory. PUM keeps it separate
from pi's own configuration directory.

| Platform | Default directory |
|---|---|
| Linux | `$XDG_CONFIG_HOME/pum` or `~/.config/pum` |
| macOS | `~/Library/Application Support/pum` |
| Windows | `%XDG_CONFIG_HOME%\pum` or `~\.config\pum` |

| Path | Purpose |
|---|---|
| `auth.json` | Provider credentials and custom-provider keys |
| `models.json` | Custom endpoints and model metadata; submitted keys are not stored here |
| `settings.json` | Model and thinking level, managed by pi |
| `pum.json` | Everything in the settings panel: theme, animation, thinking traces, transcript detail, agent messages, search, writing style, explanation strength, Check mode, extra Check mode roots (`checkPaths`), sandbox, Bash output limits (`bashOutput`), subagent limit, goal retries |
| `theme.json` | Optional semantic colour overrides |
| `history.json` | Prompt history by working directory |
| `prompt-stash.json` | Cached prompts by working directory (legacy filename) |
| `sessions/` | Main conversation sessions |
| `subagents/` | Persistent subagent sessions |

`/providers delete` writes to both credential stores. It removes the credential
from `auth.json` for every provider. For a custom provider it also removes the
definition from `models.json`. See [controls](controls.md) for the command.

## Session settings

Changes in `Ctrl+P` apply to the current session and persist beside it, leaving
the global `pum.json` alone. Press `s` in the panel to promote the current
settings to the global defaults.

## The `/settings` command

`/settings` is the text front end for the same state the panel owns.

| Input | Result |
|---|---|
| `/settings` | Lists every `pum.json` key, its value, and its scope |
| `/settings <name>` | Shows one value, its scope, and the accepted values |
| `/settings <name> <value>` | Changes it for this session |
| `/settings <name> <value> --global` | Also writes that one key to `pum.json` |
| `/settings checkPaths add\|remove\|clear` | Runs the `/check-path` action |

A name matches the `pum.json` key or the panel label. Case, spaces, hyphens, and
underscores do not distinguish two settings, so `checkMode`, `check-mode`, and
`"check mode"` are the same name. Values match without case. An unknown name
lists the near matches, and a rejected value lists the accepted ones.

`--global` writes only the one key. The rest of `pum.json`, and this session's
other overrides, stay as they were. `s` in the panel remains the way to promote
every setting at once.

Advanced keys the panel does not show are reachable here with their dotted
names, such as `/settings bashOutput.maxBytes 8192`. Model, thinking level, and
provider logins are not `pum.json`, so they keep their own panels.

`Tab` completes the setting name and then the accepted value. `Enter` accepts
the highlighted suggestion.

## Companion files

Small pieces of state live beside a session's JSONL rather than inside it, named
after it — `<session>.goal.json`, `.todo.json`, `.news.json`, `.settings.json`,
`.tool-groups.json`, `.relocation.json`. They never enter the model's context,
they are written atomically, and a missing or corrupt one is simply no state:
losing a todo list must never stop a session opening. Deleting a session sweeps
its companions with it.

## Prompt cache and history

PUM preserves every cached prompt occurrence and keeps the 100 most recent sent
history occurrences for each working directory. A repository's Git worktrees
share one cache identity, so history and the stash follow you between them;
non-Git directories stay isolated.

Session history shows the latest sent user-message time, the on-disk JSONL size,
and known outgoing, incoming, and cache-read token counts. Corrupt or partially
written session lines do not stop the history popup opening.
