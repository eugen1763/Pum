# Shared-directory file conflicts (#65)

Shared workers see the same live files as the main agent and the user. PUM now
checks `write` and `edit` against **runtime-owned read and proposal baselines**.
This detects common lost-update conflicts; it is not filesystem isolation, an
ownership assignment system, a transaction, or an automatic merge of semantics.

## Behavior

- A stable successful `read` records the actual resolved file's fingerprint for
  that runtime. Main and every mutable worker have independent observations.
  Partial reads also observe the file version; they do not claim the agent saw
  every line. Native image handling and filename retries remain unchanged.
- `write`/`edit` proposals pin the runtime's last retained observation, or the
  file at proposal time if no observation exists, before asynchronous Check
  review. Parallel proposals retain independent immutable baselines, including
  multiple proposals from one agent. Model input cannot select another owner,
  supply a trusted baseline, or force a conflict through.
- Covered mutations serialize by canonical target identity in this PUM process.
  On entry after waiting, PUM compares the pinned baseline with the current file;
  it checks again at the actual write boundary inside pi's mutation queue.
  A different file or worktree directory can proceed independently.
- A stale **whole-file write is rejected**. Deletion, replacement, another
  worker's successful write, or an external change can make it stale. Two
  concurrent creation proposals cannot silently overwrite the winner.
- A stale **edit is rejected unless every old-text target occurs exactly once
  in both the baseline and current text, and its complete touched lines are
  unchanged**. This permits disjoint-line edits and preserves other changes.
  It deliberately rejects same-line overlaps, fuzzy matches, ambiguous targets,
  missing targets and unprovable rebases. Stale rebases also reject mixed or
  bare-CR line endings that native edit would normalize outside the targets;
  uniform LF/CRLF and a leading UTF-8 BOM remain supported. A multi-edit proposal
  fails as a whole if any target conflicts. Native matching, BOM/CRLF handling and diffs still
  apply after admission. This is text-level detection, not proof of semantic
  independence (for example, a changed declaration can affect an untouched use).
- A successful safe rebase reports that other changes were preserved and asks
  the agent to read again. It does **not** promote those unseen changes into a
  fresh observation. A normal successful mutation records its own postimage;
  failed or aborted mutations do not refresh the baseline.
- If no prior read observation remains, PUM checks changes since proposal time
  and **warns that earlier changes were not checked**. Read existing files before
  mutating them. Reading through Bash does not establish a file-tool observation.

Conflicts appear as ordinary failed tool results with instructions to reread,
reconcile, coordinate ownership, or use `spawn_subagent` with `worktree: true`.
Do not bypass a conflict with Bash. Separate worktrees avoid shared-path edits;
Git integration can still have conflicts later.

## Scope, lifecycle and bounds

The guard applies with Check mode on **or off**, in TUI main, mutable managed
workers, and headless main. Readonly/plan/internal roles do not acquire mutation
capabilities. Authoritative extension instances own the state, not agent-supplied
IDs or claims. New/resumed/replaced runtimes start fresh: replayed reads are not
fresh observations. Explicit disposal releases observations. In-runtime context
rollover does not restore files or grant a new baseline.

At most **128 observed files and 8 MiB of file bytes per runtime** are retained,
oldest refreshed observation first on eviction. Files up to **1 MiB** use bounded
descriptor reads, identity/timestamps and SHA-256. Larger files retain
**metadata-only** observations, emit a limitation notice on mutation, and cannot
use stale-edit rebasing. Retained baseline eviction likewise causes an explicit
no-prior-read warning on the next existing-file mutation. There is no on-disk
baseline, manifest, preimage in a prompt, or private-state replay. Normal tool
arguments, read outputs and conflict notices retain their ordinary transcript
behavior. At most 128 pending proposals and 8 MiB of their baseline bytes are
admitted per runtime; these can retain additional snapshot references/bytes until
execution or settlement. Authority binds the exact prepared argument object,
not a tool-call ID alone; duplicate IDs cannot replace an earlier baseline.

Current project/additional roots, sensitive paths, symlink/junction and hard-link
checks still apply. Canonical platform identities key observations and the
process-local mutation queue; raw relative/absolute spellings do not select a
second owner. Pending calls retain their own snapshot even if a later read
refreshes the runtime's observation.

## Checkpoint interaction

TUI file checkpoints still capture successful mutations at the actual write
boundary. A rejected stale proposal creates **no checkpoint**, because no write
ran. A safe rebased edit captures the actual immediately preceding bytes,
including another worker's changes, not the stale observation. `/checkpoint clear`
does not clear mutation observations. Recovery continues to export a fresh
exclusive-created sibling and never changes the original or refreshes its
baseline. Its existing postimage conflict checks remain independent.

Headless uses the same mutation guard with checkpoint retention disabled; it
still reports that recovery checkpoints are unavailable. See
[file checkpoints](file-checkpoints.md) for all recovery limits.

## Explicit limits

**Bash, user `!` commands, managed shells, triggers, validation formatters, Git,
MCP/extensions, external editors and other PUM processes do not participate in
this guard's queue or establish read baselines.** Their changes may be noticed
on the next covered mutation, but PUM does not prevent, checkpoint, attribute or
roll them back. A tool's knowledge before its first retained read/proposal is
unknown; no-prior-read warnings are intentionally not claims of safety.

These are check-time observations, not portable compare-and-swap. An external
actor can write after the final check or move an ancestor between checks. A
file changed and restored between observations is not guaranteed detectable;
metadata-only large-file checks are weaker than hashed byte checks. No file
watcher, cross-process lock, OS filesystem isolation, automatic retries or
force-overwrite switch is provided. Use explicit worktree isolation and review
when concurrent ownership or semantic dependencies are unclear.
