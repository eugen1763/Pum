# PUM

A small Bun coding agent: pi's agent loop and persistent sessions inside an
OpenTUI/React terminal UI, with PUM-owned configuration and credentials.

```sh
bun run login       # PUM's own provider login
bun run start       # TUI in the current directory
bun run typecheck
bun test tests/<relevant-test>.test.ts
```

## Mandatory reading and authority

This file is the always-loaded core, **not the complete contract**. Detailed
locked decisions remain mandatory in the [agent guidance index](docs/agent-guidance/README.md).
Before editing or planning changes, read every applicable topic below and its
linked feature documents. Cross-cutting changes must read all affected topics.
Use the [source layout](docs/agent-guidance/layout.md) when ownership is unclear;
do not infer that an omitted detail is permission to change it.

| Task | Required current guidance |
|---|---|
| Startup, CLI, providers, login, dependencies | [Architecture](docs/agent-guidance/architecture.md), [CLI](docs/cli.md), [configuration](docs/configuration.md); security for auth |
| Check policy, paths, subprocesses, credentials, readonly roles, release | [Security contracts](docs/agent-guidance/security.md), [Safety](docs/security.md), [implementation cautions](docs/agent-guidance/implementation-cautions.md) |
| Session identity, ownership, relocation, settings, memory, context, diagnostics | [Sessions/context](docs/agent-guidance/sessions-context.md), [operational settings](docs/operational-settings.md), [context budgets](docs/context-budgets.md), [history](docs/transcript-history.md), [diagnostics](docs/request-diagnostics.md) |
| Agents, goals, queues, caches, tools, triggers, hosted search | [Agents/tools](docs/agent-guidance/agents-tools.md), [subagents](docs/subagents.md), [goals](docs/goals.md), [tools](docs/tools.md); security for capability changes |
| File checkpoints, automatic validation | [Security contracts](docs/agent-guidance/security.md), [checkpoint copies](docs/file-checkpoints.md), [validation](docs/project-validation.md), [draft provenance](docs/draft-command-provenance.md) |
| MCP, LSP, consent, capability lifecycle | [Security contracts](docs/agent-guidance/security.md), [MCP](docs/mcp.md), [LSP](docs/lsp.md), [draft provenance](docs/draft-command-provenance.md), [operational settings](docs/operational-settings.md) |
| TUI, input, rendering, transcript/replay, theme, clipboard | [TUI contracts/keys](docs/agent-guidance/tui.md), [implementation cautions](docs/agent-guidance/implementation-cautions.md), [TUI testing](docs/agent-guidance/testing.md), [controls](docs/controls.md), [appearance](docs/appearance.md); security for secrets/consent |

Root and topic contracts are current maintainer instructions. User-facing feature
docs explain current scope and limitations. [Historical research](docs/agent-guidance/historical-references.md)
and old debugging measurements are evidence, not current authority or new guarantees.
Use repository source/tests to resolve accidental documentation drift; flag
ambiguous conflicts rather than guessing or silently weakening a locked decision.
Change contracts only deliberately, with the task's authorization. The
[migration inventory](docs/agent-guidance/README.md#original-to-current-inventory)
traces every original section and bullet to its current anchor.

## Mandatory architecture and state rules

- Use **Bun**, **OpenTUI with React**, and **`@earendil-works/pi-coding-agent`**, not
  `pi-ai` alone. Preserve provider methods when wrapping; pi owns authentication,
  transport, model and effort APIs. Verify installed SDK docs/source before
  changing an SDK-dependent claim. Keep the matching explicit pi-server dependency
  while required by the installed SDK. Do not add/advertise an `apply_patch` tool;
  targeted mutations use pi's `edit`.
- CLI help/version exit before TUI/auth/session startup. Headless `-p` retains
  coding, memory and context tools with configured policy, not interactive
  capabilities; do not silently add consent paths or combine unsupported launch modes.
- PUM uses its own configuration directory, never pi's default store. Explicitly
  pass PUM's `sessionDir(cwd)` to session creation/resume. The **active directory is
  state**, not `process.cwd()`. Session relocation preserves one canonical JSONL,
  ID and transcript through validated aliases; no copies/forks. It is main-only,
  idle-only, one layer, refused with any retained child, and tool-driven moves wait
  for the requesting turn to settle. Missing/stale relocation fails closed.
- Mutable sessions acquire canonical ownership **before opening** existing JSONL;
  aliases share the lock. Stop work before disposal/release. Never reclaim by
  elapsed time, heartbeat expiry or recursive deletion: only demonstrably dead
  same-host/same-Linux-PID-namespace ownership can be recovered; uncertainty blocks.
- Session settings stay beside that session; only explicit user promotion writes
  global defaults. Model/effort persistence goes through pi's Settings APIs.
  `/clear` and `/new` start from global settings without the old goal/overlay.
- Memory and operational observations are runtime-private, append-only updates
  at complete tool-call/result boundaries, never system-prefix rewrites or durable
  historical snapshots. Withdrawn/invalid memory supersedes earlier facts. Memory
  mutation is main/headless-main only; workers read; judges/AFK get neither.
- Context recovery belongs only to the active session. Structural history exposes
  metadata, not private data. **No automatic summarization or rollover.** Explicit
  `new_context` commits only after the entire successful batch, retains the full
  transcript/session ID, and generates no summary; an optional handoff is literal.
  Manual compaction is refused after a PUM rollover boundary. Context budgets are
  approximate and runtime-local; full/delta transport is **not** server cache hit/miss.
- Optional tools are hidden per session with canonical role-allowlist order.
  Reveal changes next-request schemas, never consent or role authority. Bind every
  runtime's context, memory, policy and search lifecycle before its first turn;
  replacement/resume must not inherit runtime-only trust.

## Mandatory security boundaries

- Never expose credentials, OAuth URLs, raw private memory, raw prompts or session
  identifiers in diagnostics/logs. Login secrets stay outside React labels and
  session data; browser launch uses credential-free validated HTTP(S) direct argv,
  never a shell. Generic agent tools cannot write PUM configuration. Controlled
  `memory_edit` is the sole model-driven config-write exception, not an allowance
  for auth, models, settings, themes or sessions. Release credentials are never
  printed/persisted; publication uses trusted GitHub OIDC, beta vs latest as appropriate.
- File tools stay inside project/approved roots, reject sensitive paths and
  symlink/junction components, validate the actual read candidate, and refuse
  multiply-linked mutations. Trusted staged output roots are readable only, never
  writable. Canonical platform identity, not raw spelling, determines containment.
  These are check-time process-local guards, **not OS isolation** or atomic rollback.
- Check is **on/off**. On requires complete deterministic validation: hard blocks
  cannot be overridden. External writes, execution/location/unknown access, direct
  external-read uploads, credentials, privilege escalation, persistence, remote
  scripts, destructive Git and broad deletion remain blocked. Explicit classified
  external reads and complete project-local calls can pass. The verifier is advisory:
  explicit `UNSAFE` blocks; unavailable/unclear/failed/timed-out review alone does
  not block a fully validated call. No approval popup/store or revived strict/ask mode.
  Preserve the narrow direct-main npm exception and pack/install restrictions in
  [security contracts](docs/agent-guidance/security.md); a policy exception is not
  user authorization to publish. The documented dist-tag breadth conflict is
  [explicitly unresolved](docs/agent-guidance/security.md#policy-wording-ambiguity).
- Native Bash/shell policy comes from exact checked arguments and authoritative
  runtime state. Mutable model Bash/managed shells use local execution with Check
  Off or Sandbox Off; Auto probes and warns on fallback; Require blocks without
  enforcement. Direct-user `!` Bash retains Sandbox Auto/Require even Check Off.
  **Readonly Bash always
  requires native readonly, networkless enforcement**, even Check Off; no fallback.
  Windows accepts MXC BaseContainer only, never AppContainer+DACL. Mount readonly
  sources before writable roots, then private temp/denied masks. Network grants
  are broad, not domain-filtered. Triggers retain checked direct argv but do not
  inherit native Bash isolation. The inner controller does not sandbox the TUI;
  outer `pum s/sr` does, and its MVP exposes mounted PUM credentials inside gVisor.
- Security tightening applies immediately; relaxation waits until **all affected
  runtimes truly settle**, including setup, retries, internal roles and user shells.
  Pending desired values are not effective policy. Exact argument identity and
  security epochs recheck asynchronous preflight and tool entry; stale approvals
  fail closed. This cannot undo already-admitted OS work or provider dispatch.
- Consent uses the **exact live bound runtime**, zero own activity owners and both
  SDK streaming flags false, not App busy alone. Every `/mcp`, `/lsp`, `/validation`
  and `/checkpoint` operation requires direct-user draft origin. Cached/history/
  queued/restored text, edits or completion never upgrade authority. Reveal,
  repository config, model/extension input, replay and Check review grant no consent.
- MCP and LSP are main-TUI-only, explicit runtime consent, bounded pinned stdio
  subsets; no automatic startup, inherited trust, installers or remote/auth routes.
  Mandatory Linux Bubblewrap, readonly live cwd, private scratch, no network or
  additional roots, and denied PUM config apply even Check/Sandbox Off. Fail closed
  without native enforcement. Readonly does **not** mean secret-free: arbitrary
  project secrets/aliases/future files remain a disclosed exposure. Treat server
  text as untrusted data. MCP separates discovery from exact-toolset approval;
  LSP only exposes explicitly checked cached Python-document diagnostics, revalidated
  at exposure, not workspace intelligence or automatic repair. Revocation,
  changed identity/bytes, failure/cancellation and disposal withdraw authority.
- Checkpoints export a new exclusive-created recovery copy, **never overwrite or
  delete originals or rewind conversation**; they are bounded runtime preimages of
  successful file-tool writes/edits only. Automatic validation requires separate
  direct-user exact-proposal/runtime approval (explicit headless digest), runs one
  bounded checked batch at awaited `turn_end`, first failure stops, automatic repair
  budget zero. Trust is not inherited, persisted or granted by editing config.
- Hosted search authorizes only exact bound main/mutable-worker requests; readonly,
  judge, AFK, unknown/unbound and direct verifier calls fail closed. Preserve live
  revocation across async hooks/retries and before dispatch. The observer is not
  authority. Do not force SSE to observe requests or confuse search policy with
  network isolation for arbitrary Bash/extensions.

## Mandatory agent lifecycle and workflow

- Shared-directory managed subagents are the default; use worktrees for concrete
  isolation/conflict needs. Count only `starting`/`running` against active capacity
  (default 10, configurable 1–25). Prefer independent managed work when slots exist;
  at capacity queue related work to an appropriate agent with `message_agent`, or
  report the routing blocker. Never create hidden queues or unrelated assignments.
- After spawning available work, **end the turn and yield**. Never poll background
  agents with sleep, shell loops or repeated status calls. Completion notifications
  resume coordination. For pending cached tasks, call `message_cache_send` with
  stable IDs **before** spawning/assigning; preview/list/read is not execution.
  Reuse assignments when the authoritative coordination prompt arrives.
- `finish_subagent` is the **sole completion notice**. `message_agent` is for
  questions, blockers, coordination and actionable intermediate information, never
  final reports. Close only after a completion notice and authoritative `completed`
  status (merge also requires persisted acknowledgement). Idle, ordinary messages
  and delivery acceptance are not completion. Do not reply to acknowledgement/status
  loops or notices without new work/questions.
- Close retained descendants **recursively, deepest-first**, before a parent finishes,
  merges or is removed. Every retained status blocks closure. Merge completed
  worktree children; remove completed shared-directory children. Never force-remove
  managed work to discard failures/unmerged changes. Stop is not closure. Close
  promptly unless a concrete dependency, conflict risk or integration order requires
  waiting. A child can stop only its own descendants.
- Settle on **`agent_settled`, not `agent_end`**: retries still own activity. User
  shell commands have their own lifetime. Explicit disposal must release runtime
  services after work stops; SDK disposal is not a session_shutdown event or OS kill.
  Keep queued messages pending until actual `message_start` insertion.
- Goal judges review only, never implement. Invalid/missing/duplicate/stale verdicts
  fail closed; one accepted incomplete verdict owes one continuation, never polling.
  Cancelling a turn stops the goal first. Preserve goal generation, verdict bounds,
  terminal states and exactly-once continuation rules in the topic contract.
- Keep checked tools out of mixed parallel batches: read first, then checked Bash/
  edit; run process-starting `create_trigger`, `resume_trigger`, `invoke_trigger`
  separately. Structured processes preserve executable/argv boundaries, exact
  target identity, inert bounded output/templates and supervised cleanup.
- Respect the current task's scope. Guidance and roadmap entries do not authorize
  releases, unrelated changes, commits/pushes or issue closure. Use issue tracking
  when assigned, record design before major interfaces/safety changes, validation
  and limitations before closure, and obtain independent review where required.

## Validation and UI invariants

- Run focused behavioral tests and typecheck; do not replace behavioral/security
  regressions with source-string checks. Documentation changes run
  `bun test tests/agent-guidance.test.ts` and `git diff --check`. Keep the indexed
  migration manifest current for intentional contract revisions; never remove
  coverage or constraints to save tokens.
- TUI changes require rendered/mock-agent evidence, not typecheck alone. Read the
  [tmux/mock-provider workflow](docs/agent-guidance/testing.md): assert session
  survival, use exact tmux targets, never pipe TUI stdout, isolate test PUM_DIR,
  and measure layout. Report skipped native/Windows/live-provider tests honestly.
- Colours use semantic theme tokens, plain Unicode glyphs, and one signal meaning.
  Preserve the one-row status bar, compact layout, native prompt cursor blinking,
  stable memoized animation context and bounded transcript mounting. UI projections
  never rewrite durable transcript content. Main, child and replay paths share tool
  row/streaming construction; reasoning is captured regardless of display setting.
  Read the full TUI and caution contracts before changing focus, streaming or layout.
