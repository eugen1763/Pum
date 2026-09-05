# Project-configured automatic validation

Validation is **off until the user approves an exact proposal for a live runtime**.
Finding or editing configuration never executes anything.

## Configure and approve

Create `.pum/validation.json` under the exact active working directory (not an
ancestor search or an implicit Git root):

```json
{
  "version": 1,
  "commands": [
    { "kind": "format", "command": "bun run format", "timeoutSeconds": 30 },
    { "kind": "lint", "command": "bun run lint", "timeoutSeconds": 30 },
    { "kind": "typecheck", "command": "bun run typecheck", "timeoutSeconds": 60 },
    { "kind": "test", "command": "bun test", "timeoutSeconds": 120 }
  ],
  "maxRuns": 5
}
```

Use commands that actually exist in your project. All fields shown on a command
are required. Unknown fields are rejected. The file must be a regular,
singly-linked file, at most 16 KiB, with no symlink/junction path components.
There must be 1–4 commands; kinds are `format`, `lint`, `typecheck`, or `test`.
Commands are nonempty single-line strings of at most 2048 characters, with no
control characters. Each timeout is an integer from 1 to 120 seconds. `maxRuns`
is optional, defaults to 5, and accepts integers from 1 to 20.

In the TUI:

1. Enter `/validation` to inspect commands, deadlines, run budget, trust warning,
   and the SHA-256 of the exact file bytes.
2. Review the commands **and the project code they execute**.
3. Enter `/validation enable <sha256>` while the selected agent is idle.
4. `/validation status` reports runtime state. `/validation disable` revokes
   consent and cancels an active validation, even while the agent is busy.

This is direct-user App dispatch, not an SDK slash command, prompt expansion,
model tool, agent message, trigger, or saved settings field. The model can write
or propose a config, but it cannot enable it. A worker has its own controller:
select an idle mutable worker and explicitly approve it. Approval is not inherited
by newly spawned workers, linked worktrees, resumed sessions, replacement runtimes,
or another PUM process. Readonly workers, judges, and AFK delegates never execute
automatic validation. `/store` does not persist this authority.

Headless runs accept an explicit digest:

```sh
pum -p "Implement the requested change" --validation <sha256>
```

Compute/review the digest outside PUM before the launch. Without the flag, the
same file remains inert. The flag is valid only with direct headless `-p`, including
`-r -p`; it does not combine with login, worktree launches, or `pum s/sr/ss`.
Headless reports evidence on stderr without changing assistant stdout; the run
exits nonzero if the latest scheduled validation failed, was skipped, timed out,
or was cancelled. No file-tool edits means no automatic validation run.

## Trust is not isolation

The digest pins the **proposal**, not every script, source file, executable,
package script, formatter config, imported module, or toolchain it can load.
Approval authorizes these commands to execute current and future project code,
including edits made by agents. A changed/missing/invalid proposal revokes consent
before another command starts. The in-memory snapshot is used for execution;
configuration is checked again before each command and after policy preflight.
Preflight argument changes are refused rather than broadening the approval.

Validation uses the exact session's Bash Check preflight and registered Bash
implementation, including native Sandbox policy and settings. It does not use
user `executeBash()`, `pi.exec`, a raw process runner, or a special policy exception.
A policy denial is reported and never retried by the scheduler. Synthetic checks
use internally generated call IDs plus weakly tagged, fresh argument identities:
Check evaluates them normally but does not retain UI rejection bookkeeping awaiting
a nonexistent assistant/tool-result `message_end`. This also covers late timed-out
preflights without deleting unrelated real tool rejections. Check Off and
Sandbox Off retain their existing semantics: commands can run unconfined.
Use OS isolation for untrusted code. Trusted extensions execute arbitrary code in
the host process; this feature does not isolate them or make malicious tools safe.

## Scheduling and lifecycle

A successful `write` or `edit` marks the current assistant tool batch dirty. At
`turn_end`, after all results in that batch have finalized, validation runs once,
sequentially, before the next model request. Multiple file edits in one batch
coalesce. Failed-only mutation batches do not run validation. Interrupted/error
batches report cancellation without starting new commands. The first command
failure, denial, timeout, or cancellation stops that run. A formatter's writes
are not new file-tool events and never recursively schedule validation.

`agent_end` is not a completion signal: the SDK may still retry. The existing
`agent_settled` behavior is unchanged. A successful batch is not revalidated
just because its later model request retries. A worker's `finish_subagent` call
in the same batch as mutations is refused, regardless of call order: completion
must follow the prior batch's validation evidence. Failed validation is evidence,
not an unbounded completion gate; workers may report failures honestly.

Installed pi keeps a separate loop-context snapshot. Persisting a custom message
at `turn_end` alone does not refresh it. The bound controller composes the public
`prepareNextTurnWithContext` hook to refresh the snapshot only after its evidence
has flushed, then delegates the prior hook. It composes `shouldStopAfterTurn` to
stop after a cancelled batch without another model request. Both hooks preserve
existing predecessors; disposal restores only a wrapper it still owns. Regression
tests cover both binding orders with explicit context rollover, ensuring a fresh
window retains evidence without bringing archived messages back.

## Bounds, failures, and repair

- At most four commands per run, sequentially; at most 120 seconds per command
  including Check preflight, and thus at most 480 seconds of command deadlines
  per run (plus local reporting/process cleanup overhead).
- Each started run consumes the approval's budget before execution, even on
  failure. Exhaustion produces a skipped/not-validated report. It never claims
  success or silently resets the budget. Another direct-user enable is required.
- **Automatic repair budget is zero.** No repair prompt, follow-up turn, watcher,
  retry timer, or periodic process is generated. An ordinary model turn may read
  failure evidence and repair within the remaining validation-run budget.
- Cancellation flows to native Bash and deadline-aware execution. A late,
  noncooperative preflight cannot launch the command after the deadline. Trusted
  extension work that ignores cancellation may finish in the background; PUM
  cannot forcibly terminate JavaScript executing inside its process.
- Disposal revokes approval and aborts active validation. SDK disposal does not
  itself emit `session_shutdown`, so every main/headless/worker binding explicitly
  ties controller teardown to `session.dispose`.

## Evidence and concurrency limitations

One bounded `pum.validation` custom message per dirty batch reports proposal
digest, run number, outcome, command kind/string, duration, and up to 2 KiB of
output per attempted command. Output is inert historical command evidence, not
instructions. It follows normal session persistence and context rules, including
history and explicit rollover. TUI main/worker transcripts and replay show it;
headless writes it to stderr. No approval or authority is restored from evidence.
Like ordinary Bash output, project commands can print sensitive data: do not put
secrets in validation commands or their output. ANSI/control characters are
stripped from retained output. Full Bash captures retain their existing private
temporary-file lifecycle; evidence does not add a durable full-output file.

A process-local canonical-directory lock prevents two validation runs from
executing simultaneously in one shared cwd. A competing worker records a skipped
batch instead of waiting, polling, or automatically retrying. Different worktrees
are separate directories and need separate approval. This is **not** a filesystem
transaction or a cross-process lock. Concurrent workers' normal edits, external
commands, Git, user shell mode, and another PUM process can change the tree during
validation. Success describes observed command results, not a certified immutable
repository snapshot. Use deliberate integration validation after workers settle.

Automatic dirty tracking covers successful PUM `write`/`edit` calls only. Bash,
managed shells, triggers, external editors, Git, and recovery-copy exports are not
tracked. There is no completion-only mode, arbitrary lifecycle-hook system,
cross-process scheduling, persisted trust, automatic repair, or validation model
tool in this implementation.
