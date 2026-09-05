# Conversation branches and rewind (#50)

## Scope chosen by the user

`/branch` and its `/rewind` alias select a conversation path **inside the same
session**. They do not create a second session or copy a transcript. The canonical
JSONL file, session UUID, ownership lock, relocation aliases and complete original
tree remain. New-file forks are deferred; this workflow is not `/fork` or `/new`.

This is **conversation navigation only**. Source files, Git state, recovery copies,
private project memory and current companion state are not rewound. No summary,
file restore, automatic submission or destructive Git operation runs.

## Selection and authority

Type the command directly in the main TUI. While the selector is open it owns the
keyboard: popup shortcuts, prompt input and paste do not reach anything else, and
no key applies a branch before the explicit second confirmation. The bounded selector offers ordinary
text-only user prompts for re-editing and completed assistant endpoints for
continuation. Selecting a user prompt means returning **before** that prompt;
selecting an assistant endpoint means continuing **after** it. Confirm the chosen
point explicitly; cancelling the selector changes no conversation state.

Private custom entries, hidden messages, tool arguments/results, provider
signatures and private rollover handoffs are not selection previews. Image-bearing
user prompts are not re-edit targets: text-only restoration must not silently lose
attachments. Archived-window indicators describe ancestry, not hidden contents.

Every operation requires ref-backed direct-user draft origin. Cached, historical,
queued or programmatically restored command text cannot invoke it. Editing and
completion do not upgrade origin. Any restored earlier prompt is itself a
**restored, untrusted draft**, never fresh command authority. Clear a nonempty draft
with Ctrl+C and type anew to issue a direct command. See
[draft provenance](draft-command-provenance.md).

Selection is capped at 100,000 transcript entries; user re-edit text is capped at
100,000 UTF-16 code units and is restored exactly, never silently truncated.
Previews are separately bounded and stripped of terminal control characters.
Oversized/unsupported points are not selectable. Mutation additionally requires a
stable, singly-linked, valid UTF-8 version-3 JSONL file of at most 64 MiB, with a
complete final newline and an exact match to the live transcript. Missing, partial,
legacy, replaced or mismatching files refuse before migration-capable SDK reopen.

Navigation refuses active or uncertain runtime activity, pending delivery/input,
attached images or pasted-text payloads, session/worktree/recovery transitions,
retained workers at any status, and outstanding automation or process work. It
requires the exact-runtime idle predicate, not just the visible working indicator.
An active or blocked goal must be stopped first, and no goal continuation may be
owed. Refusal is not cancellation and does not silently discard queued input.

The selection is bound to the exact runtime and transcript state. New entries,
a changed leaf or runtime replacement invalidate an old selection. Open the
selector again rather than applying a stale choice to a different conversation.

## Current companions, not historical snapshots

| State | Branch behavior |
| --- | --- |
| Canonical JSONL and session identity | Same file and UUID; every original entry remains |
| Relocation and aliases | Same validated relocation and canonical ownership |
| Goal | Current stopped/terminal record retained; no automatic continuation |
| Todos | Current list retained, not reconstructed from old tool results |
| PUM session settings | Current overlay retained; global defaults unchanged |
| Model and effort | Current selection retained through pi-owned APIs; global defaults unchanged |
| Tool groups | Current enabled groups retained in canonical role order; reveal is not consent |
| News | Current records/read state retained, including answers on other paths |
| Workspace prompt cache/history | Existing workspace scope unchanged |
| Project memory | Current shared project memory remains; no historical private snapshot restored |
| MCP/LSP/validation consent | Revoked with old runtime; direct approval required again |
| File checkpoints | Old runtime preimages discarded; no filesystem recovery |
| Context meter, diagnostics and request observations | Fresh runtime-local projections, not restored measurements |

Current goals/todos/News can refer to work later than the selected point. That is
intentional: companions are session-wide current state, not branch checkpoints.
Review them explicitly rather than assuming conversation navigation reversed work.

## Persistence, ownership and rollover

Pi's leaf pointer alone is not durable: restart selects the last appended entry.
PUM therefore records a small context-excluded custom navigation anchor at the
chosen ancestry. Existing entries are never removed or rewritten. A continuous
canonical lock reservation bridges retirement and rebuilding of the same-file
runtime. An alias is a pointer to that ownership, not a second session or lock.

The rebuilt runtime restores the last PUM rollover boundary on the selected
ancestry. Its literal handoff remains literal; no summary is generated. Later
windows and other branches remain in the full transcript for bounded `history`
recovery, without automatically reentering model context. Private structural data
remains withheld by history. Before-boundary navigation intentionally returns to
that earlier context; it does not erase the boundary on the original path.

Runtime replacement revokes old request grants and consent, closes old capability
resources and starts fresh private memory, operational and calibration projections.
Idle approved MCP/LSP connections are not themselves active agent work; retirement
withdraws them rather than transferring approval to the replacement.

## Failures and limitations

The installed SDK does not expose its deferred custom `nextTurn` queue through
`pendingMessageCount` or the public core queue predicate. PUM therefore binds an
early runtime-local tracker before startup hooks/admissions and conservatively
refuses branching for the rest of that runtime after **any** `nextTurn` enqueue,
even if it was later consumed. It stores no message body or durable metadata.
Untracked runtimes also refuse. Current PUM delivery paths do not use this SDK
queue. A clean restart/resume starts a new tracker, but **do not restart as an
automatic workaround**: an unconsumed transient queued message could be lost.
Resolve pending input deliberately first. Ordinary SDK/core queues and pending
Bash input have independent refusal checks.

Before asynchronous shutdown, PUM permanently freezes the exact idle old runtime's
public/core prompts, custom/steering/follow-up queue insertion, user-shell admission,
and native summary/tree-navigation calls. Retained old SessionManager file/branch
mutators also refuse; PUM reopens a separately validated manager under the same
lock to append the selected path only after cleanup. Abort and disposal remain available; the freeze neither releases
ownership nor pretends work was cancelled. A trusted main callback synchronously
revokes this exact runtime's PUM capability controllers - MCP, LSP, project
validation, retained file-checkpoint preimages and hosted-search request grants -
before any awaited shutdown hook can still reach them. The public SDK extension runner emits
`session_shutdown` with reason `resume` and the same canonical target file, then
runs the existing before-invalidation callback and session disposal, matching the
same-file replacement cleanup order. This runs under the still-held canonical
lock with a **five-second** wait; it is not an application `quit` event. Native
tree/fork hooks are not invoked. A fresh runtime is created only after successful
cleanup.

Failed or timed-out cleanup leaves the old runtime frozen and ownership retained;
no selected-path anchor or replacement runtime may be published. A timeout cannot
stop arbitrary noncooperative JavaScript or certify that its external resources
closed. This case requires explicit shutdown/recovery, not an automatic rollback
runtime racing the still-running cleanup. An explicit disposal attempt while cleanup
is still pending also refuses and retains ownership; after actual cleanup settles,
explicit disposal can release it without rerunning shutdown hooks. Process exit
ends local ownership, but is not proof that arbitrary extension-created external
resources were cleaned up. Cleanup that changes the transcript invalidates the
selection rather than silently choosing a different snapshot. Ordinary creation
failures **after** successful retirement retain the append-only rollback behavior
below.

Navigation does not provide an atomic filesystem transaction or undo arbitrary
extension side effects. A replacement failure must preserve canonical ownership
and restore original ancestry with an append-only rollback anchor before rebuilding
the original selection. Failed runtime resources are disposed. A failed append or
failed recovery must fail closed rather than report success or continue with an
uncertain conversation. Existing JSONL and companion files must never be truncated,
rewritten or deleted as rollback.

The lock is cooperative local-filesystem ownership, not isolation against arbitrary
writers or older PUM versions. Path/identity checks are observations, not portable
filesystem compare-and-swap. Historical model messages may still describe files or
runtime capabilities that no longer exist. Conversation navigation cannot restore
those capabilities, code bytes, external side effects or previously paid work.

Focused regression evidence and any remaining implementation limits are recorded
in issue #50 before integration. This document makes no paid-provider, Windows or
native-sandbox validation claim.
