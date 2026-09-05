# File checkpoints: safe recovery copies

PUM can retain the bytes immediately before a successful agent `write` or `edit`
and let **the user** export those bytes to a **new file**. This is recovery, not
in-place rewind. The user explicitly selected this scope for issue #43: portable
filesystem APIs cannot atomically compare the original against a fingerprint and
replace it without a race against an external editor.

## Use

In the TUI, select the main agent or a retained mutable worker, then type:

```text
/checkpoint
/checkpoint list
/checkpoint recover <id>
/checkpoint clear
```

Listing shows checkpoint IDs, paths, tool names and whether the file previously
existed. Recovery requires the selected agent to be idle. It exports the preimage
to an exclusively created `pum-recovery-<random UUID>.txt` sibling and reports its
path. **The original is untouched. Review the copy and apply it manually.** No
command silently replaces or deletes the original; no destructive Git command,
conversation navigation, retry rewind or goal-driven restore runs.

A checkpoint for a newly created file records *prior absence*. There are no prior
bytes to export; recovery refuses and never deletes the newly created file. An
empty existing file, in contrast, has a valid empty preimage.

These are direct-user TUI actions, not model tools or SDK extension commands.
Pasted-text attachment contents are not command authorization. Reports are
process-local UI rows, not checkpoint content persisted to conversation history.

## Coverage and limits

- TUI main and mutable managed workers use independent runtime-local stores.
  Select the worker before listing or recovering its records; closing it loses
  its store. Readonly workers, goal judges and AFK delegates have no store.
- **Headless `-p` has no checkpoints** and says so on stderr. A process-only store
  would be useless after its one-shot exit. Resuming that conversation does not
  recover any earlier bytes.
- Only successful covered `write` and `edit` executions can produce records.
  The implementation wraps pi's public tool-definition factories, preserving
  schemas, argument preparation, edit matching, line endings and diff results.
  Capture runs inside pi's native per-file mutation queue at the actual write
  operation, not the earlier `tool_call` preflight.
- **Bash is not checkpointed.** Neither are user `!` commands, managed shells,
  triggers, Git/worktree operations, extensions, other processes or filesystem
  side effects outside the covered file. Conflict checks may notice their
  changes to a covered file but do not back them up.
- At most **32 records and 8 MiB of preimage bytes per runtime**, oldest first.
  Both source and resulting file must fit **1 MiB**. The store counts metadata
  separately through the record cap; transient per-call reads are bounded but
  are not part of the retained-byte total. Multiple runtimes each have this cap.
- Oversized, unsupported, inaccessible or unstable captures retain no record.
  Successful calls report retained/prior-absence/skipped status without preimage
  contents. Failed or aborted tool executions create no record even if a partial
  filesystem mutation already happened. Checkpoints are not a transactional
  mutation engine or an emergency backup for failed writes.
- Clear, runtime replacement (including worktree relocation), session switch,
  reload, worker closure and process exit discard bytes. Crash recovery and
  restart/resume retention are deliberately absent. In-runtime context rollover
  does not itself replace the store, nor does ordinary branch navigation, but
  neither action restores files.
- There is no checkpoint file, manifest, config setting or historical preimage
  in session JSONL, provider messages or logs. Normal tool inputs/results keep
  their existing transcript contracts. Checkpoint result notices can therefore
  outlive the runtime they described; only the current `/checkpoint` list is
  authoritative. Clearing releases references; it is not guaranteed physical
  memory zeroization or protection from OS swap/core dumps.

## Conflict and security model

Capture and recovery reuse filesystem sandbox write validation with the current
project and additional roots. Recovery never grants a new root. Revoked roots,
credential-sensitive paths, the PUM config boundary, credential-like filenames,
symlink/junction components, non-regular files and multiply linked files are
refused. No source-file permissions or ownership are changed.

Bounded descriptor reads verify the opened descriptor against the named file
before and after reading. Fingerprints include device/inode identity, link count,
mode, size, modification/change timestamps and SHA-256 of the bytes. Supported
edits also compare the pre-write file with the edit's read snapshot; a detected
read/write conflict refuses the mutation. A checkpoint is retained only if the
observed postimage matches the tool's intended bytes.

Recovery compares the current original with the recorded postimage and refuses
on differences (including same-content replacement or changed metadata). There
is no force/ignore-conflict switch. This deliberately means an older checkpoint
usually cannot be recovered after another edit; this MVP is not a general backup
browser or chained undo stack.

Recovery participates in pi's same-process file mutation queue. Different paths
can still proceed independently. Other PUM processes, shells and external editors
do not participate in that queue. The new recovery file is opened with exclusive
creation, checked again before writing, and revalidated after writing alongside
the original. If concurrent work is detected, recovery fails rather than touching
the original. Hashes/metadata are observations, not portable filesystem CAS or
proof that a file has never changed and changed back. A later external write can
still occur after the final observation; because PUM never replaces the original,
that work is not overwritten by recovery.

Path/link checks retain the existing filesystem sandbox's **check-time** limits.
There is no cross-platform directory-descriptor traversal or protection against a
malicious same-user process swapping/moving ancestors between checks. An external
actor able to move directories, relink files or change permissions remains in the
local filesystem trust boundary. Do not treat recovery as an OS security sandbox.

## Export failures and portability

Export preserves preimage bytes exactly (including binary bytes, BOM and CRLF).
The filename uses `.txt` to avoid activating the original file type. Creation
requests mode `0600`, never executable; Windows permissions depend on inherited
ACLs and the filesystem. Original executable bits, ACLs, ownership, extended
attributes and timestamps are not restored.

The destination is never opened with overwrite/truncate semantics and no rename
replaces a path. A failure after exclusive creation can leave an empty, partial
or complete recovery artifact. PUM reports its path for user inspection and does
**not** unlink it: another actor might have edited or replaced that name. Exported
copies are user-owned files, not tracked temporary files, so clear/exit never
remove them and they can accumulate outside the in-memory retention cap. Recovery
can be repeated, creating a distinct file each time. Copies inside the project
can be read by ordinary project tools and may appear in Git status; do not commit
them accidentally. Store them as carefully as the original source.

Filesystem APIs and path identities are shared with the cross-platform sandbox;
there is no Linux-only replacement syscall or destructive Git fallback. Tests run
native filesystem cases, with platform facility skips only where links are not
available. Passing Linux tests is not a claim that Windows was executed locally.
