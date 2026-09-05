# Plan mode (#51)

## What it is

`/plan` puts the **main** session into an enforced readonly role. `/implement`
is the only way out. This is a capability gate, not a prompt style: plan mode
removes the tools rather than asking the model to behave.

The session, its canonical JSONL, UUID, ownership lock and relocation aliases
are unchanged. Entering or leaving rebuilds the runtime on that same file, the
way [conversation branches](conversation-branches.md) do, so the transition
itself never restores files, rewrites the transcript or runs a Git operation.

## What plan mode blocks

Plan mode reuses the four layers a readonly worker already gets, so removing a
tool schema is never the only defense:

| Layer | Effect |
| --- | --- |
| Tool set | `write`, `edit`, `memory_edit`, mutable delegation, triggers, managed shells, message-cache mutation and the MCP tools are absent from the schemas |
| Call guard | The same set is refused at call time and the visible tool result says why |
| Filesystem sandbox | Only `read` may reach the filesystem through the file tools |
| Native Bash sandbox | Bash runs with read-only project roots, or not at all |

`worktree` keeps `list` and `status` and refuses every mutating action.
Project validation runs configured project commands, so `/validation enable` is
refused while plan mode is on and any earlier approval is revoked by the rebuild.
MCP tool registration is withheld and `/mcp connect` and `/mcp approve` are
refused: PUM cannot certify an arbitrary server as non-mutating, so it fails
closed rather than reasoning about a server's intent. LSP stays, because it is
[document-only](lsp.md). Hosted web search, `read`, todos, context tools,
project-memory reads and questionnaires all stay.

## When native enforcement is unavailable

Bash **fails closed**, exactly as it does for a readonly worker: it is blocked
while the Sandbox setting is Off, and blocked with the backend's own reason when
no enforced backend is available. Plan mode never degrades Bash to a direct local
shell and never emits a "continuing unsandboxed" warning in this role.

Entering plan mode still succeeds in that state, because the mutation tools are
gone at both the schema and guard layers, which do not depend on a backend. The
entry message says so; it is not something to discover at the first blocked call.

Direct-user `!` Bash is **your** authority, not the agent's, and keeps working
with its configured native sandbox. Plan mode restrains the agent; it does not
pretend to restrain you.

## Entering, recording a plan, and leaving

| Command | Effect |
| --- | --- |
| `/plan` | Enter plan mode, or show the current status and plan when it is already on |
| `/plan <text>` | Record or replace the plan text, then enter plan mode if it is off |
| `/implement` | Show what leaving restores and arm the confirmation |
| `/implement confirm` | Leave plan mode |

Both commands are main-transcript-only and require ref-backed direct-user draft
origin, exactly as `/branch`, `/mcp`, `/validation` and `/checkpoint` do. Cached,
restored, queued or completion-derived text can never invoke either, and any
submission that is not direct disarms a pending `/implement`. See
[draft provenance](draft-command-provenance.md).

Entering only removes capability, so it needs no confirmation. Leaving is the
upgrade, so it needs a second directly typed command rather than a keypress: a
restored draft can never carry the confirmation.

Both transitions need the same admission gate as a conversation branch: exact
runtime idleness, no pending input, delivery or Bash work, no attachments, no
retained worker at any status, no session, worktree or recovery transition in
flight, and a stopped or terminal goal with no owed continuation. A goal drives
mutation, so it cannot start or continue while plan mode is on. Refusal is not
cancellation and never discards queued input.

The status bar shows `PLAN` for as long as the role is in force. It is a mode
disclosure, so it is never dropped or truncated to make room for anything else.

## Persistence and resume

The plan text lives in an ordinary companion file beside the session, like a
goal or a todo list, and is kept as written.

The **mode** is recorded twice, and the session starts restrained if either
record says so:

- a companion record of the current mode, and
- an append-only, context-excluded transition entry in the canonical JSONL.

So a missing, truncated or invalid companion cannot silently give mutation back,
and only an explicit `/implement confirm` ever appends an exit record: no crash,
rollback or companion loss can fabricate one. Unreadable ancestry restrains
rather than releases. A session with neither record is an ordinary session.

The JSONL side is read on the selected ancestry, so this composes with
conversation branches: navigating back to a point before the plan keeps plan mode
on until you explicitly leave it, never the other way round.

## Headless

`pum -p "<prompt>" --plan` runs one headless prompt in the same role, with the
same tool set, guard and sandbox layers. `--plan` requires `--prompt` and cannot
be combined with `--validation` or with any command.

Headless cannot transition in either direction. There is no direct-user
confirmation path there, and adding one silently would breach the headless
contract. A session whose recorded mode is plan resumes restrained in headless
too, with or without the flag, and `--validation` is refused in that state.

## Failures and limitations

A transition may only ever fail toward the **more restrictive** role. A failed
`/implement` leaves plan mode on, keeps canonical ownership and reports that
recovery is required, rather than producing a half-upgraded runtime; unsettled
shutdown keeps the frozen runtime and the lock exactly as
[conversation branches](conversation-branches.md#failures-and-limitations)
describe. Existing JSONL and companion files are never truncated, rewritten or
deleted as rollback.

The lock is cooperative local-filesystem ownership. This is not protection
against arbitrary code execution inside the App process, and not a second OS
credential boundary. A plan-mode model can still write out a mutation for you to
run yourself; that is the point of the mode, not a bypass. Historical transcript
messages may describe tools plan mode has removed. No paid-provider, Windows or
native-sandbox compatibility claim is made here.
