# Session, persistence and context contracts

Current mandatory implementation guidance. Read before changing identity, relocation, ownership, settings, memory or context. Related current details: [configuration](../configuration.md), [context budgets](../context-budgets.md), [history](../transcript-history.md), [diagnostics](../request-diagnostics.md), [operational settings](../operational-settings.md). See the [topic index](README.md).

## Project memory is agent-managed private state.

<a id="ld-020"></a>

- **Project memory is agent-managed private state.** PUM stores one `MEMORY.md`
  under `<config dir>/memory/projects/<sha256>/`, outside the repository. Git
  repositories use the canonical absolute Git common directory as their identity,
  so the primary checkout and every linked worktree share one file even when the
  checkout paths differ. Non-Git directories use their canonical directory
  identity. The main agent and headless main agent can call `memory_read` and
  `memory_edit` without user approval. Worker agents can call only `memory_read`;
  goal judges and AFK delegates get neither memory context nor memory tools.
  PUM reads memory before every model call. `memory-context.ts` keeps a runtime-private
  snapshot per active window and inserts changed observations at fixed source-message
  boundaries. Updates append after complete tool-call/result blocks, never between
  them, and explicitly supersede earlier memory. Unchanged reads and retries add
  nothing. Empty/deleted memory withdraws earlier facts; invalid/unavailable memory
  adds a generic withdrawal notice, and recovery appends the latest valid content.
  No injected snapshot enters the durable transcript or a companion file. Explicit
  memory tool inputs/results retain their ordinary transcript contract.
  `new_context` deliberately consolidates to current memory without a summary;
  the context meter includes the retained update chain. Resume, runtime replacement,
  branch changes, and manual compaction start a new projection. This trades prefix
  continuity across restarts for not persisting historical private memory. It does
  not establish provider cache-hit behavior. Current user instructions and repository
  evidence take priority. Memory holds at most 200 lines or 25 KiB, rejects credential-like
  content, uses exact revision-checked replacements, a cross-process lock, and an
  atomic rename. This controlled writer is the sole model-driven exception to the
  generic config-directory write block.

<!-- end:ld-020 -->

## A session can move between directories without forking.

<a id="ld-021"></a>

- **A session can move between directories without forking.** `/worktree start`
  creates an auto-named worktree and switches the session to its own file with
  a new `cwd`, so the session id, transcript and companion state stay put and
  nothing is copied. `/worktree return` moves it back and leaves the worktree,
  its branch and any uncommitted work alone. One layer only, main agent only,
  idle only, and refused while any managed child is retained. `start` and
  `return` are reserved words, never worktree names.

<!-- end:ld-021 -->

## A tool-driven move waits for the turn that asked for it.

<a id="ld-022"></a>

- **A tool-driven move waits for the turn that asked for it.** `worktree` with
  `start` or `return` records the intent and returns; the App moves the session
  from the settle handler. The calling turn has to finish against the directory
  it began in, or the rest of it runs against roots that changed underneath.
  Managed children, mutable or not, are refused: a delegate does not get to
  move the session it is not running in.

<!-- end:ld-022 -->

## The active directory is state, not `process.cwd()`.

<a id="ld-023"></a>

- **The active directory is state, not `process.cwd()`.** Everything
  directory-dependent reads it, so a move rebinds by re-render. A relocated
  session keeps its source repository writable for that process only; this
  never reaches the saved `/check-path` settings.

<!-- end:ld-023 -->

## Relocation fails closed on resume.

<a id="ld-024"></a>

- **Relocation fails closed on resume.** A worktree that is gone, pruned or now
  on a different branch drops the record and stays in the source repository,
  because authorizing a stale path could hand writes to a directory the user
  never chose.

<!-- end:ld-024 -->

## Relocated sessions use aliases, never copied JSONL files.

<a id="ld-025"></a>

- **Relocated sessions use aliases, never copied JSONL files.** The canonical
  session stays in its source session directory. A bounded pointer in the
  generated worktree's session directory makes `-r` and session history resolve
  that same file. Source subdirectories receive a source-root pointer too.
  Return removes the worktree pointer. Alias loading validates the canonical
  session, relocation identity, generated branch, and source/worktree paths;
  stale, corrupt, linked, missing, or replaced targets fail closed.

<!-- end:ld-025 -->

## Session settings live beside the session.

<a id="ld-026"></a>

- **Session settings live beside the session.** `<session>.settings.json` holds
  only the fields that differ from global, following the same atomic-write and
  defensive-load rules as the goal and todo companions. An empty overlay deletes
  the file rather than leaving a stub beside every session. `/clear` and `/new`
  start from the global settings, because the overlay belongs to the session
  that set it.

<!-- end:ld-026 -->

## Context tools belong to the active session.

<a id="ld-044"></a>

- **Context tools belong to the active session.** `history` searches and reads
  that session's transcript. Structural-entry reads return metadata only, allowing
  `parentId` traversal without exposing private custom data. History pages execute
  sequentially and budget prior history results in the same tool batch. Search
  continuation uses a bounded authenticated `nextCursor` with the same query,
  never a nonzero numeric offset. It binds the session, query, original append-only
  transcript prefix and next match offset, so newly persisted recovery calls/results
  cannot shift pages. Cursors survive in-runtime rollover and branch changes, but
  expire on runtime replacement/restart. No cursor registry or transcript cache is
  persisted. Read text continues by stable entry ID and UTF-16 offset; a nonzero
  text offset attaches no images by default unless image pagination is explicit.
  Each serialized result carries the historical-data notice once. See
  `docs/transcript-history.md` for scope, validation and limitations.
  `get_context_remaining` reports the context budget.
  `new_context` requests an explicit rollover after the entire tool batch succeeds.
  Rollover retains the canonical session ID, session file, and full entries.
  Rollover generates no summary. The caller can supply an optional literal handoff.
  Automatic summarization is disabled locally; rollover is explicit, not automatic.
  Manual `/compress` is unchanged before the first rollover. With an active PUM
  rollover boundary, the controller refuses manual compaction before native
  summarization or authentication preflight. The installed SDK prepares the
  persisted branch, including archived windows, and ignores the synthetic literal
  handoff. `new_context` remains supported, and the transcript stays complete.
  Settings saves cannot re-enable automatic compaction in these runtimes, and
  saved defaults are not changed.
  Main, headless, and managed worker runtimes each own a controller, including readonly workers.
  Internal judges and AFK delegates get none of these schemas.
  Register the controller before memory injection and bind it immediately after session creation.

<!-- end:ld-044 -->

## Context calibration is runtime-local and approximate.

<a id="ld-045"></a>

- **Context calibration is runtime-local and approximate.** Only a successful
  assistant response paired with a matching request/model/API/capacity/window and
  unchanged source/response fingerprints anchors the meter. Invalid, all-zero,
  output-only, total-only, restored or stale usage is not trusted. The measured
  total is never scaled or capped. UTF-8 bytes / 3, message/schema framing and
  1200 tokens per image estimate the tail and positive prompt/schema/injection
  growth; an upward-only 1–2 factor from a >=1024-token request calibrates only
  those heuristic terms. Observed overhead growth retains a per-anchor high-water
  mark until newer trusted usage includes it; shrinkage never subtracts from the
  measurement. History fitting shares the factor and framing reserve. No raw
  prompt/private-content calibration copies, transcript calibration entries or
  companion files are created. Stable common guidance and a synthetic header use
  actual active tools, after group narrowing, plus identity-marked registered
  memory injection. Supplied memory needs no routine reread; empty/withdrawn
  notices do not restore facts. Missing/hidden todos need not be enabled, and
  history recovery is selective. Main/headless/workers participate; internal
  judges/AFK remain excluded. Explicit no-summary rollover and bounded small-model
  response headroom remain. See `docs/context-budgets.md` for formulas and limits.

<!-- end:ld-045 -->

## Request diagnostics are opt-in and ephemeral.

<a id="ld-046"></a>

- **Request diagnostics are opt-in and ephemeral.** Only `PUM_REQUEST_DIAGNOSTICS=1`
  enables collection. `/diagnostics [clear]` reads or clears the selected session's
  safe report, never a durable transcript entry or model message. Headless emits
  enabled reports on stderr before teardown and leaves stdout unchanged. Retain at
  most 64 requests per process, clear at shutdown, and write no diagnostic files.
  Reports contain hashes, lengths, finite codes, and memory revision metadata, never
  raw prompts, private memory, secrets, errors, or IDs. Full/delta transport does
  not mean server cache hit/miss. Local prefix comparisons are explanatory, not
  the SDK continuation decision (whose baseline includes the prior assistant
  response); SDK debug counters are process-local/session-scoped, with unsupported
  providers unavailable. See `docs/request-diagnostics.md`.

<!-- end:ld-046 -->

## Sessions persist

<a id="ld-047"></a>

- **Sessions persist** to `<config dir>/sessions`.

<!-- end:ld-047 -->

## Mutable sessions have one process owner.

<a id="ld-048"></a>

- **Mutable sessions have one process owner.** TUI, headless, and managed-child
  runtimes acquire a canonical JSONL ownership lock before opening existing
  sessions, because pi can migrate a file during `SessionManager.open`.
  History metadata remains readable. A locked history target fails before the
  current runtime is changed. Source and worktree aliases share the canonical
  lock. Same-file relocation reserves ownership across teardown and rebuild;
  independent owners conflict even inside one process. New sessions acquire
  ownership before service setup, and disposal releases it after work stops.
  The lock publishes a populated directory atomically. Unique owner files let
  competing stale recoveries remove only the owner they inspected. Never use
  recursive deletion, elapsed time, or heartbeat expiry to reclaim ownership.
  Recovery requires a demonstrably dead PID on the same host and Linux PID
  namespace. Live or reused PIDs, permission errors, foreign namespaces, and
  malformed owners fail closed. This is cooperative local-filesystem ownership,
  not a boundary against older PUM versions or arbitrary file writers.

<!-- end:ld-048 -->

## Operational state does not rewrite the system prefix.

<a id="ld-087"></a>

- **Operational state does not rewrite the system prefix.** Capacity and effective
  Check policy use runtime-private append-only request observations, retained at
  fixed complete-tool-block boundaries. Unchanged requests/retries add nothing.
  Current observations supersede older ones but never authorize tools. Main and
  mutable workers receive capacity notices; readonly/headless/judge/AFK do not.
  Memory and context-window accounting include the complete retained chain.
  Replacement, branch changes and explicit no-summary rollover start a fresh
  projection; no operational companion, durable rewrite or automatic rollover.
  Writing/explanation changes apply at the next accepted prompt, Bash presentation
  at the next tool call, UI preferences immediately. Tool-group enablement keeps
  its canonical next-request schema and existing tool-result notice.

<!-- end:ld-087 -->

## `/model` and `/effort` use the main session's Settings APIs.

<a id="ld-107"></a>

- **`/model` and `/effort` use the main session's Settings APIs.** `/model`
  opens the existing model picker. `/model <name or provider/id> [effort]`
  matches exact case-insensitive identities or names, refuses ambiguous names,
  and validates effort before changing the model. `/effort [level]` sets or
  reports effort using the installed pi capability list. Both commands complete
  available values. Selected children are refused, never silently retargeted.
  `/store` and `/s` call the same global promotion as Settings `s`.

<!-- end:ld-107 -->

## Model and thinking level are pi's to persist.

<a id="ld-108"></a>

- **Model and thinking level are pi's to persist.** Explicit main-user model
  and effort selections call `setModel()` and `setThinkingLevel()` with
  `{ persist: true }`. Without that option, pi changes only the session.
  Startup reads pi's defaults from `<config dir>/settings.json`. Popup `s`,
  `/store`, and `/s` also save the current main model and effort through pi's
  `SettingsManager`, without switching models or resetting effort. Child setup,
  login selection, and automatic provider fallback do not overwrite defaults.
  `pum.json` holds only what pi does not know about, including UI preferences,
  web search, check mode, and writing style.

<!-- end:ld-108 -->

<a id="conversation-branches"></a>

## Explicit same-session conversation navigation (#50)

The user selected same-session branch/rewind only; new-file forks are deferred.
`/branch` and `/rewind` change the selected ancestry in one canonical JSONL/UUID,
retaining the entire original tree and all rollover archives. They never copy,
truncate or rewrite existing transcript entries, restore files, run Git mutations,
generate summaries or automatically submit a restored prompt. See the required
[conversation branch details](../conversation-branches.md).

Current goals/todos/settings/News/tool groups/relocation remain current session
state, never historical snapshots reconstructed from an earlier point. Require
stopped/terminal goals without an owed continuation. Canonical ownership must
remain continuously reserved across same-file runtime replacement and rollback;
validated relocation aliases still resolve that exact ownership. A private,
context-excluded append-only navigation anchor makes the chosen leaf durable.
A failed replacement restores original ancestry by another append-only anchor;
failed append/recovery fails closed, never by rewriting/deleting JSONL or companions.

Rebuild runtime-local capabilities rather than transferring consent or private
projections. Permanently freeze exact-idle public/core/queue/shell admissions and
revoke PUM-owned capabilities synchronously before bounded awaited normal SDK
`session_shutdown` cleanup. Keep ownership reserved. Cleanup failure/timeout must
not publish a selection or start a recovery runtime beside unfinished cleanup;
retain the frozen runtime/lock until actual cleanup settles or process exit.
Tree/fork hooks remain outside this explicit no-summary operation.
Branch selection is direct-main-user-only with ref-backed provenance,
exact-runtime idle plus pending input/delivery/setup/process guards, and no retained
worker at any status. Selection binds the exact runtime and transcript state and
revalidates at commit. Show bounded ordinary text-only user and completed assistant
points, not private/custom/tool contents. Restored user text remains untrusted draft
origin. The selected ancestry's last rollover boundary governs fresh context;
other windows remain retained, not automatically injected or summarized.
