# Tools

[← Back to the README](../README.md)

Every session always has `read`, `write`, `edit`, `bash`, `memory_read`, and the questionnaire.
The main agent also has `memory_edit`.
Everything else lives in a hidden group that the model reveals
with `enable_tools` when it needs it, so a schema the turn will not use never
costs context: **Admin** (triggers and the message cache), **Subagents**,
**Worktree**, **Shells**, and **Todo**. Revealing is one-way for the rest of the
session.

## Project memory

PUM injects private project memory before each model call. The main agent uses
`memory_read` and `memory_edit` to maintain durable facts without user action.
Worker agents can read memory, but they cannot change it. Goal judges and AFK
delegates receive no memory.

PUM stores one bounded `MEMORY.md` outside the repository. Linked Git worktrees
share the file through Git's common-directory identity. Non-Git directories use
separate files. A revision check and a cross-process lock prevent lost updates.

The file holds at most 200 lines or 25 KiB. PUM rejects credential-like content.
Current user instructions and repository files always take priority over memory.

## Interactive questionnaires

The `questionnaire` tool asks one or more questions inside the TUI. Each
question offers selectable options and a custom-answer field: arrow keys or
`Tab` to move, `Enter` to select. `Esc` cancels from the option view, or returns
to the options while you are editing a custom answer.

Answers go back to the agent that asked. Custom text stays outside React labels
and session data until you submit it. `/afk` answers questionnaires for you
while you are away — each one goes to a fresh delegate holding a single tool, no
files, no shell, no network, no delegation.

## Agent message cache

Main and managed child agents can list and read the workspace message cache, and
entries an agent creates carry exact ownership. An agent can delete only its own
entries; user-created and legacy entries stay user-owned.

`message_cache_send` takes stable entry IDs. A single entry uses the selected
agent's delivery path; several use main-agent worktree orchestration. PUM
reserves the entries during delivery and marks them executed only once delivery
succeeds — a failure leaves them pending.

## External triggers

Trigger tools supervise a command given as an executable and an argument array,
never as shell text. Definitions can be listed, inspected, paused, resumed,
cancelled, or run by hand, and they disappear when PUM exits. `Ctrl+T` or
`/processes` opens the combined Processes view; `/triggers` opens that tab.

PUM bounds definitions, pending deliveries, output size, run counts, repeat
frequency, and lifetime. Output goes to a private temporary file and is removed
once the triggered turn settles. Each event targets one exact main or retained
child session; a missing session cancels its definitions rather than redirecting
them.

## Managed shells

`start_shell` runs a supervised background process for one agent, again as
executable plus arguments. Its output is captured to a private file that
`get_shell_output` reads, and `kill_shell` ends it. Unlike triggers, a managed
shell goes through the same native sandbox as the Bash tool — see
[Safety](security.md).

## Todo lists

Each agent owns a todo list, stored beside its session, that no other agent can
read or change. The model manages it with `todo_add`, `todo_update`,
`todo_complete`, `todo_delete`, and `todo_list`; `Ctrl+O` or `/todo` opens a
view-only popup for the selected transcript, where `f` filters.

## Hosted web search

Web search is on by default for supported OpenAI Codex providers. Searches
appear as transcript tool rows and persist in resumed sessions. Other providers
continue without it. Turn it off in `Ctrl+P`.
