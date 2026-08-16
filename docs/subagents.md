# Parallel subagents

[← Back to the README](../README.md)

PUM runs up to 10 active subagents by default; configure 1 through 25 in
Settings. Only starting and running agents count toward the limit. Each subagent
gets:

- A persistent pi session
- An isolated branch and worktree under `.pum/worktrees`
- Its own transcript, draft, usage data, and cancellation state
- Tools for progress messages and a single final completion report

Select a range of cached prompts and press `Enter`: the main agent groups
related work and runs independent groups in parallel. Use `Ctrl+L` to select an
agent transcript; input then goes to that agent. Finished or interrupted agents
stay available until you merge or remove them.

## Merging

A managed merge requires both authoritative `completed` status and a persisted
completion notice. Idle settlement is not completion. A successful merge removes
the completed worktree and branch. A parent cannot finish, merge, or be removed
until every retained descendant closes, deepest first.

Idle notices report settled work cycles to the direct spawner; they are not
completion notices. PUM acknowledges completion delivery only after the notice
enters the parent session, and persisted completion intent with stable message
identifiers lets interrupted delivery resume without duplicate reports.

## Spawn preview

`spawn_subagent` accepts `preview: true`. PUM then shows the exact child task
before it creates any worktree or session. `Enter` approves, and an optional
note becomes a separate visible user instruction to the new child. `Esc` cancels
without creating a child, discarding the note, and the parent's draft survives.

## Readonly children

When the Sandbox setting is `Auto` or `Require`, `spawn_subagent` also accepts
`readonly: true`. A readonly child inspects files and runs sandboxed inspection
commands.

PUM omits `write`, `edit`, `apply_patch`, child spawning, inter-agent
delegation, process-starting trigger tools, managed shells, and message-cache
mutation from that child, and a fail-closed guard refuses anything else it was
never offered. Worktree access is limited to `list` and `status`. Bash requires
an enforced native sandbox, receives read-only project, `/check-path`, and
managed Git metadata roots, and gets no network; if enforcement is unavailable,
readonly Bash blocks rather than falling back. Readonly state survives resume,
and Sandbox `Off` removes the argument from the tool schema entirely.

## Messages between agents

A child reports progress with `message_agent` and finishes exactly once with
`finish_subagent`. A bare "done" through `message_agent` is refused: the final
summary belongs to the tool that changes the agent's status. A child can stop
only agents below it in the spawn tree.

Press `↑` on an empty single-line prompt to recall the newest queued
user-authored message for the selected transcript. PUM removes it from the
authoritative queue before restoring the text, and never recalls inter-agent,
trigger, lifecycle, cache, delivered, or image-bearing messages.

Inter-agent messages have their own setting, independent of transcript detail:
turn **Agent messages** off in `Ctrl+P` to keep them out of the transcript.
