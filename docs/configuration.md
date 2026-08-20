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

## Session settings

Changes in `Ctrl+P` apply to the current session and persist beside it, leaving
the global `pum.json` alone. Press `s` in the panel to promote the current
settings to the global defaults.

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
