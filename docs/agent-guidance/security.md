# Security and consent contracts

Current mandatory implementation guidance, not optional hardening. Read the entire applicable contract and its linked feature document before changing a boundary. Related current details: [Safety](../security.md), [operational settings](../operational-settings.md), [checkpoint copies](../file-checkpoints.md), [validation](../project-validation.md), [draft provenance](../draft-command-provenance.md), [MCP](../mcp.md), [LSP](../lsp.md). See the [topic index](README.md).

## Policy wording ambiguity

The two original Check-mode bullets are retained for traceability: [toggle and
migration](#ld-016) and [complete hard-block/advisory rules](#ld-115) describe the
same policy, not separate profiles. Read them together with this note and the
[structured-process contract](agents-tools.md#ld-123).

**Unresolved dist-tag breadth:** the early bullet and current Safety usage doc
say `npm dist-tag add ... latest`; the later original bullet omits the tag.
`isRecognizedNpmPublishMutation` in `src/check-mode.ts` recognizes one direct
command, exact-version package, and a validated safe tag, not only `latest`.
This migration does not broaden the narrow documented permission or change code.
Do not infer authority for other tags from the broader implementation; ask for
an explicit decision if a task depends on that discrepancy. Main-only identity,
complete deterministic validation, no structured-process exception, validated
options and all hard blocks remain unchanged. The source's old “Ask-mode” comment
is legacy terminology, not a surviving profile or approval popup.

Mutable model Bash/managed shells' Off bypass does not apply to direct-user `!`
Bash's configured native sandbox or readonly and MCP/LSP mandatory native
enforcement, and the inner Bash controller is distinct from outer claudebox.
These scoped clarifications resolve older absolute wording, not change policy.

## Outer sandbox commands use claudebox protocol 1.

<a id="ld-010"></a>

- **Outer sandbox commands use claudebox protocol 1.** `pum s` keeps the launch
  directory read-write. `pum sr` keeps it read-only. Positional existing real
  directories become temporary tool roots and accept final `:ro` or `:rw`
  suffixes. The launch cwd mode cannot be overridden by repeating the cwd as an
  extra mount. PUM rejects missing paths, files, links, junctions, nested outer
  launches, unsupported platforms, missing runtimes, and older protocols before
  TUI startup. Linux is native. Windows support means running Linux PUM inside
  WSL 2. The launcher hides home, then mounts the project, explicit roots, PUM
  runtime paths, and PUM's config directory. `pum sr` rejects a custom PUM_DIR
  inside the read-only project. The child uses the saved Check mode setting,
  disables nested Bubblewrap, and keeps launch roots as process-local Check and
  file-tool roots without overwriting saved user settings. This MVP places PUM
  credentials inside gVisor. When Check mode is on, it is a policy boundary, not
  a second OS credential boundary. A future host broker can remove that exposure.

<!-- end:ld-010 -->

## Browser login uses safe direct process arguments.

<a id="ld-012"></a>

- **Browser login uses safe direct process arguments.** PUM opens credential-free
  HTTP(S) auth and device-code URLs once per login attempt. Windows uses
  `rundll32.exe`, macOS uses `open`, and Linux uses `xdg-open`. PUM never uses a
  shell, logs an OAuth URL, persists an OAuth URL, or fails login when launch is
  unavailable. The popup keeps the URL selectable as the fallback.

<!-- end:ld-012 -->

## Submitted keys never enter React labels or session data.

<a id="ld-013"></a>

- **Submitted keys never enter React labels or session data.** The login
  controller keeps secrets outside React state. The popup renders only a length
  mask. Custom keys go to PUM's `auth.json`, while `models.json` contains only
  endpoint, compatibility, and model metadata.

<!-- end:ld-013 -->

## Login text paste preserves the secret boundary.

<a id="ld-014"></a>

- **Login text paste preserves the secret boundary.** OpenTUI bracketed paste
  routes endpoint and API-key text directly to the login controller. Local
  Ctrl+V fallback uses bounded clipboard output and direct process arguments;
  remote sessions do not invoke a host clipboard command. Secret contents never
  enter React labels, logs, session entries, or error text.

<!-- end:ld-014 -->

## Check mode is a single on/off toggle.

<a id="ld-016"></a>

- **Check mode is a single on/off toggle.** Off runs bash and edit without
  approval. On applies the deterministic policy plus verifier review
  (the behavior formerly called "balanced"): complete project-local calls,
  explicit external reads, and project-local edits are allowed; hard rules block.
  The verifier is advisory on top of complete deterministic validation, so an
  unavailable model, an unclear verdict, a timeout, or a transport error does not
  block a fully validated call. There is no approval popup and no exact-approval
  store; the former `strict` and `ask` profiles and their machinery were removed.
  An explicit verifier `UNSAFE` blocks, except a deterministically recognized
  direct `npm publish` or `npm dist-tag add ... latest` from the authoritative
  main agent, which is allowed outright. The exception does not depend on the
  verifier category. Managed subagents cannot use the exception. Legacy settings
  values `strict`, `balanced`, and `ask` migrate to `on`; `off` stays `off`.

<!-- end:ld-016 -->

## Active Check modes can enforce a native Bash sandbox.

<a id="ld-017"></a>

- **Active Check modes can enforce a native Bash sandbox.** PUM overrides pi's
  built-in `bash` with `createBashTool` and custom `BashOperations` in
  main and managed child sessions. For mutable model Bash/managed shells,
  Check mode Off or Sandbox Off use pi's local backend. Direct-user `!` Bash
  retains Sandbox Auto/Require even Check Off. Readonly Bash and the separate
  mandatory MCP/LSP process adapters do not use that bypass. Auto uses Bubblewrap
  on Linux or MXC BaseContainer on Windows when a
  real probe succeeds, otherwise it keeps deterministic Check mode and shows one
  process-local warning outside session context. Require blocks Bash without an
  enforced backend. Policy is recomputed from the exact approved command and
  authoritative cwd/config. Project and additional roots are writable; explicit
  on-mode external reads are read-only; PUM config, credentials, unsafe
  environment variables, and network-by-default are denied. Recognized network
  operations receive the host network, which is not domain-filtered. Linux uses
  direct `bwrap` argv, a private temp mount, `--die-with-parent`, a new session,
  and namespace/process-tree cleanup. Windows dynamically imports the alpha
  `@microsoft/mxc-sdk` and accepts only its `base-container`
  CreateProcessInSandbox tier; never enable the AppContainer+DACL fallback because
  it can change host ACLs. This inner Bash controller never sandboxes the TUI/model
  process; the separate outer claudebox launcher does confine its PUM child. External
  triggers retain deterministic checks and direct argv supervision but do not use
  this backend until approved policy can cross their synchronous spawn boundary.
  A managed shell does use it: `ShellManager` is built with
  `SandboxController.shellProcessAdapter()`, so `start_shell` and Bash reach the
  same decision from the same controller, and a shell cannot run work the Bash
  tool would have confined.

<!-- end:ld-017 -->

## Additional Check mode paths are explicit and project-scoped.

<a id="ld-018"></a>

- **Additional Check mode paths are explicit and project-scoped.** `/check-path`
  lists, adds, removes, or clears up to 16 canonical directory roots for the
  launch project. Added roots must exist. PUM rejects filesystem roots, paths
  inside the current project, credential-sensitive directories, the home
  boundary, and PUM's configuration boundary. Bash, edit, and external-trigger
  checks use the extra roots. Windows containment compares canonical identities,
  so short and long path spellings cannot disagree about authorization.
  On-mode Bash and process checks can read
  explicit external filesystem operands without adding a root. On-mode still
  blocks external
  location changes, writes, execution operands, ambiguous access, credential
  access, escaping links or junctions, broad deletion, and other hard rules.

<!-- end:ld-018 -->

## Generic agent tools do not write the PUM config directory.

<a id="ld-019"></a>

- **Generic agent tools do not write the PUM config directory.** Settings changed in the popup
  belong to the session, not to `pum.json`, and `s` in the Settings popup or
  `/store` (`/s`) deliberately promotes them to global - performed by PUM itself, never through a
  tool. The deterministic layer still supports an exact-file allowance, but
  nothing grants one, so `settings.json`, `pum.json` and `theme.json` are
  blocked for the main agent and for every subagent. `auth.json`, `models.json`
  key material and session content keep their existing hard blocks, and the
  native sandbox still denies the whole config root.

<!-- end:ld-019 -->

## Null devices and Git Bash drive paths are policy-friendly.

<a id="ld-027"></a>

- **Null devices and Git Bash drive paths are policy-friendly.** `/dev/null` is
  a null device in every path flavor, so `2>/dev/null` and `> /dev/null` no
  longer classify as external writes on a Windows cwd. A Git Bash / MSYS drive
  path such as `/c/Users/...` or `/d/dev/...` resolves to its native drive, so
  the session cwd, project roots, and `cd` targets share one canonical identity
  on Windows for the deterministic policy.

<!-- end:ld-027 -->

## The filesystem sandbox covers file tools.

<a id="ld-028"></a>

- **The filesystem sandbox covers file tools.** `read`, `write`, and `edit` are
  limited to the project and configured `/check-path` roots before execution.
  Credential-sensitive paths and symbolic-link or junction components
  are blocked. This is a process-local path guard, not operating-system
  isolation for bash, scripts, extensions, or trigger processes.

<!-- end:ld-028 -->

## The guard validates the path the tool will actually open.

<a id="ld-029"></a>

- **The guard validates the path the tool will actually open.** pi's `read` tool
  retries filename variants (NFD, curly apostrophe, narrow-space AM/PM), so
  checking the literal string would approve one path while the tool opened
  another. For a read, the sandbox resolves the same candidate in the same order
  and runs every check on that candidate.

<!-- end:ld-029 -->

## PUM's own staged temp directories are readable, never writable.

<a id="ld-030"></a>

- **PUM's own staged temp directories are readable, never writable.** Captured
  bash output lives in per-process directories that PUM
  registers explicitly. Reads inside a registered root are allowed so the model
  can retrieve what it was told to read; writes there are still refused, and the
  credential rules still apply. A model-supplied temp path never matches.

<!-- end:ld-030 -->

## Mutating a multiply-linked file is refused.

<a id="ld-031"></a>

- **Mutating a multiply-linked file is refused.** A hard link is an ordinary file
  to `lstat`, so containment alone cannot tell whether an in-project name aliases
  content outside the project. Writes and edits to a file with a link
  count above one are blocked; reads stay allowed, because hard links are common
  in real trees. The check cannot say where the other links point, and it is a
  check-time test rather than a guarantee against a link created afterwards.

<!-- end:ld-031 -->

## File checkpoints export recovery copies, never rewind originals.

<a id="ld-032"></a>

- **File checkpoints export recovery copies, never rewind originals.** TUI main
  and mutable workers retain at most 32 successful write/edit preimages and 8 MiB
  per runtime, with a 1 MiB file cap and FIFO eviction. Capture runs inside pi's
  native mutation queue. Direct-user `/checkpoint [list|recover <id>|clear]`
  exports prior bytes to a new exclusive-created sibling, checks current roots,
  sensitivity, links and postimage fingerprints, and never overwrites/deletes
  the original or changes conversation history. A new-file record has prior
  absence, not deletable undo. No recovery model tool or SDK slash command exists.
  Runtime replacement, worker close and exit discard private in-memory bytes;
  bind every main/mutable worker's disposal explicitly because SDK dispose does
  not emit session_shutdown. Headless reports no checkpoints. Bash, shells,
  triggers, Git and external mutations are not covered. Failed exports may leave
  an artifact for user inspection; never unlink a name another actor could have
  changed. See `docs/file-checkpoints.md` for check-time race and retention limits.

<!-- end:ld-032 -->

## Automatic validation requires direct-user runtime approval.

<a id="ld-033"></a>

- **Automatic validation requires direct-user runtime approval.** Exact-cwd
  `.pum/validation.json` is inert, strict bounded version-1 JSON. Direct App
  `/validation` previews commands and their SHA-256; `/validation enable <digest>`
  approves only the selected idle mutable runtime. No SDK command, model tool,
  inherited worker consent, saved setting, or replayed evidence grants authority.
  Headless requires `--validation <digest>` with direct `-p`. Changed/missing/invalid
  config revokes; disable and disposal abort. Approval trusts the commands and
  current/future project code they execute, not merely proposal bytes. Successful
  write/edit batches validate once at awaited `turn_end` through the session's
  Check preflight and registered native-sandbox Bash, never user executeBash.
  Preserve `agent_settled` lifecycle; compose next-turn context refresh so evidence
  reaches the model without reviving rolled-over history, and stop on abort.
  Finish plus mutation in one worker batch is refused. At most four commands,
  120s each including preflight, 1–20 runs per approval (default 5), first failure
  stops, automatic repair budget zero. Same-cwd concurrent validators skip rather
  than poll; external/Bash edits are not tracked or isolated. Readonly/judge/AFK
  roles never run it. Bounded historical `pum.validation` evidence persists in the
  normal transcript; trust does not. See `docs/project-validation.md` for limits.

<!-- end:ld-033 -->

## Readonly subagents require Sandbox Auto or Require.

<a id="ld-083"></a>

- **Readonly subagents require Sandbox Auto or Require.** The `spawn_subagent`
  schema exposes `readonly` only when Sandbox is not Off. Live Sandbox changes
  update the registered TypeBox schema objects. Execution and direct manager
  calls reject readonly requests while Sandbox is Off. The snapshot persists
  the flag, and resume restores it. Readonly children omit `write`, `edit`, child
  spawning, inter-agent delegation, process-starting trigger
  tools, and message-cache mutation tools. A fail-closed child hook blocks
  unknown tools and mutation-capable combined tools. Worktree access permits only `list`
  and `status`. Main agents cannot create external triggers for readonly children.
  Readonly Bash never uses direct fallback. It requires native enforcement even
  when Check mode is Off, mounts the project, additional roots, and managed Git
  metadata read-only, and denies Bash network access. Existing readonly children
  stay fail-closed if the user later changes Sandbox to Off. Main-agent behavior
  and mutable child behavior remain unchanged.

<!-- end:ld-083 -->

## Security relaxation waits for all affected runtimes to settle.

<a id="ld-088"></a>

- **Security relaxation waits for all affected runtimes to settle.** Desired UI
  settings persist immediately and a pending notice distinguishes effective
  values. Check on, stronger sandbox, removed roots and search off tighten now;
  Check off, weaker sandbox, added roots and search on commit together only after
  main, workers (including readonly), internal roles and user shell activity truly
  settle. Async admission/setup reserves activity. `agent_end` does not release
  retries, and retained inactive records do not block. Pending long-worker delays
  are user-approved. Capacity limits are operational and change immediately without
  killing existing workers. A monotonic effective-security epoch invalidates
  pending Check/structured-process approvals after asynchronous review. The bound
  full preflight chain and core file/process execute entries both recheck it, so
  an earlier prepared parallel call cannot run while a later sibling crosses a
  revocation. Synthetic validation uses the same route. This remains a check-time
  tool-entry boundary, not rollback or an atomic OS transaction.
  Search additionally snapshots role-effective state at
  the context boundary and checks a live disable epoch after async payload hooks;
  disable/re-enable never revives an old request capability. A dispatched hosted
  request or already-admitted OS process cannot be retroactively confined. See
  `docs/operational-settings.md` for timing and limitations.

<!-- end:ld-088 -->

## Idle consent uses exact-runtime activity, not App busy or SDK session flags alone.

<a id="ld-110"></a>

- **Idle consent uses exact-runtime activity, not App busy or SDK session flags alone.**
  `isRuntimeIdle` requires a live fully bound session, zero own public/core/shell
  owners and both SDK session/core streaming flags explicitly false. Unbound,
  binding and disposed runtimes fail closed. An old cancelled SDK preflight can
  clear session/App busy while a newer core run continues. App MCP connect/approve,
  LSP connect/check and validation enable retain transition/selected-runtime guards;
  main MCP/LSP callbacks and real validation enable independently check exact idle.
  Unrelated runtime reservations do not block an idle session. Direct revoke,
  disconnect, stop, disable and cancellation remain available during active work.
  See `docs/operational-settings.md` for SDK-dependent scope and admission limits.

<!-- end:ld-110 -->

## Direct-user command authority belongs to the draft origin.

<a id="ld-111"></a>

- **Direct-user command authority belongs to the draft origin.** App keeps a
  ref-backed direct/restored origin independent of cache indices. All `/mcp`,
  `/lsp`, `/validation` and `/checkpoint` operations (including preview/list/status and
  revoke/disable) refuse cached, historical, queued or programmatically restored
  drafts. Editing and completion never upgrade origin; per-view switches preserve
  it and failed delivery restores untrusted text. No-op navigation cannot clear
  it. Ctrl+C on a nonempty draft explicitly clears it so the user can type anew.
  Submission snapshots authority before clearing the editor. See
  `docs/draft-command-provenance.md` for the conservative policy and UI regressions.

<!-- end:ld-111 -->

## MCP is an explicitly approved main-TUI capability.

<a id="ld-112"></a>

- **MCP is an explicitly approved main-TUI capability.** Exact-cwd `.pum/mcp.json`
  is an inert proposal. Direct `/mcp` preview and `/mcp connect <server> <digest>`
  authorize process discovery only; separate `/mcp approve <server> <toolset-digest>`
  permits exact discovered tools. Cached/stashed commands, model/extension input,
  Check review and `enable_tools` never grant consent. The optional main-only MCP
  group contains static PUM `mcp_list`/`mcp_call` schemas, not server definitions.
  Calls require the exact bound SessionManager instance, ID and cwd. Workers,
  readonly agents, judges, AFK and headless have no server access. Nothing starts
  or inherits trust on launch/resume/runtime replacement. Revoke, cancellation,
  failure, config bytes or path identity changes, tool-list changes and disposal
  withdraw authority. File watchers revoke on relevant renames rather than trusting
  detached old inodes; boundary revalidation also checks config/ancestor identity.
  Linux Bubblewrap is mandatory even with Check/Sandbox Off: no fallback/network,
  fixed credential-free environment, readonly cwd only (no additional roots),
  minimal system runtime mounts and exact external executable file, never its
  directory. PUM configuration remains denied. The user approved live-project
  residual exposure: bounded sensitive-name masks are defense in depth, not a
  guarantee against arbitrary secrets, aliases or future files returned to the
  model. Recursive scans do not follow links and fail closed on bounds/errors.
  General Bash sandbox policy stays unchanged. Protocol is pinned legacy
  2025-11-25 tools-only stdio, not latest/full MCP. No OAuth, remote transport,
  installers, resources, sampling, prompts or URI following. Treat descriptions,
  schemas and bounded text results as untrusted data. See `docs/mcp.md` for limits
  and missing native-enforcement evidence on hosts without Bubblewrap.

<!-- end:ld-112 -->

## LSP is an explicitly approved main-TUI document diagnostics capability.

<a id="ld-113"></a>

- **LSP is an explicitly approved main-TUI document diagnostics capability.**
  Exact-cwd `.pum/lsp.json` is inert strict version-1 executable/args JSON. Every
  `/lsp` command uses the same ref-backed direct-user origin guard as MCP, including
  preview/status/problems/stop. Preview then `connect <digest>` grants only one
  runtime's process authority; `check <relative.py>` explicitly checks one bounded
  Python document. Nothing starts from model/cache/repository configuration alone,
  resume, relocation, startup, or worker inheritance. The unchanged reviewed MCP
  process adapter mandates native Linux Bubblewrap, readonly live cwd, private
  scratch, filtered environment, denied PUM config, no network/additional roots or
  unsandboxed fallback even Check/Sandbox Off. Preview explicitly discloses the
  readonly live-project secret/alias/future-file risk; no writes/auth are authorized.
  LSP 3.17 Content-Length stdio supports full synchronization and full document
  pulls only, requiring UTF-16 and no inter-file/workspace diagnostics. No real
  server compatibility claim, workspace intelligence, server-driven edits,
  navigation, installers or remote transport. Generation plus exact bytes/file and
  ancestor identity/timestamps gate acceptance and every tool/problems exposure;
  edits, stale results, cancellation and failures withdraw evidence. Config changes,
  runtime disposal and relocation revoke trust. Main-only hidden LSP contains just
  `lsp_diagnostics`, which reads cached untrusted evidence and cannot start/check
  anything. Compact `/lsp problems` output and ordinary tool copies are historical
  once delivered, not automatically refreshed. No steering/repair/context injection.
  Workers/judges/AFK/headless have no LSP authority; `-p` is explicitly unsupported.
  See `docs/lsp.md` for exact scope, limits and absent-host native evidence.

<!-- end:ld-113 -->

## Release publication uses npm trusted publishing.

<a id="ld-114"></a>

- **Release publication uses npm trusted publishing.** GitHub OIDC publishes
  prereleases under `beta` and stable versions under `latest`, with npm
  provenance. The workflow does not promote prereleases to `latest` and does
  not use an `NPM_TOKEN`. Never print, persist, or expose registry credentials.

<!-- end:ld-114 -->

## Check mode on has deterministic hard blocks and advisory verifier review.

<a id="ld-115"></a>

- **Check mode on has deterministic hard blocks and advisory verifier review.**
  On blocks only hard-rule, explicitly suspicious, clearly dangerous, obfuscated,
  malformed, or incompletely analyzed calls. On permits ordinary complete
  project-local calls. On also permits explicit, deterministically classified
  external reads. The policy classifies operands as read, write, execute,
  location, or unknown. External writes, execution operands, location changes,
  and unknown access remain hard blocks. Direct external-read uploads also remain
  hard blocks. Verifier review is non-blocking after complete deterministic
  validation, so an `UNSAFE` verdict blocks but an unclear verdict, an
  unavailable model, a timeout, or a transport error does not. On blocks escaping
  links or junctions, credential access, privilege escalation, persistence,
  remote-script execution, dangerous destructive Git, and broad deletion. Hard
  blocks cannot be overridden. The only `UNSAFE` exception is a narrow
  deterministic match for direct `npm publish` or `npm dist-tag add` from the
  authoritative main agent, which is allowed outright without any popup. The
  verifier category does not control the match. Managed subagents remain blocked.
  There is no fail-closed profile: on is the former balanced behavior, so the
  deterministic layer is the real gate and the verifier only tightens it.

<!-- end:ld-115 -->

## On-mode npm pack is narrow and deterministic.

<a id="ld-116"></a>

- **On-mode npm pack is narrow and deterministic.** PUM accepts only one direct
  `npm pack` command with lifecycle scripts disabled and an explicit cache path.
  A package operand must be one exact registry package version. Cache and pack
  destinations must resolve inside the project or an approved additional root.
  File, Git, URL, tag, range, ambiguous, credential, external-write, composed,
  and global-install forms remain blocked. This rule does not change the
  main-agent allow exception for `npm publish` or `npm dist-tag add`.

<!-- end:ld-116 -->

## On-mode release installation is narrow and deterministic.

<a id="ld-117"></a>

- **On-mode release installation is narrow and deterministic.** PUM accepts
  only one direct `npm install` of one exact registry package version. The
  command must include `--ignore-scripts`, an explicit `--prefix`, and an
  explicit `--cache`. Both paths must resolve inside the project or an approved
  additional root. File, Git, URL, tag, range, ambiguous, credential,
  external-write, composed, alias, global, and unsupported-option forms remain
  blocked. General package installation and lifecycle-enabled installation
  remain blocked.

<!-- end:ld-117 -->

## Check mode verifies complete structured proposals.

<a id="ld-118"></a>

- **Check mode verifies complete structured proposals.** Bash requests include
  all stages, operators, pipelines, redirections, substitutions, environment
  assignments, mutation intent, and boundaries. `edit` requests include the
  proposed unified diff, changed paths, line counts,
  sensitivity flags, project containment, complete-content findings, and a
  SHA-256 digest. Invalid, stale, malformed, or incompletely analyzed requests
  block without mutation. Length alone does not block a fully validated on-mode
  call. When an on-mode verifier prompt exceeds its bound, PUM sends complete
  validation metadata and digests. PUM never silently substitutes a truncated
  raw prefix or suffix. The verifier returns decision, category, confidence, and
  reason. Clear legacy `SAFE` and `UNSAFE` replies remain compatible. One unclear
  reply can receive one bounded adjudication under the shared 15-second watchdog.

<!-- end:ld-118 -->

## Checked tools stay out of parallel mixed batches.

<a id="ld-119"></a>

- **Checked tools stay out of parallel mixed batches.** pi prepares every tool
  in a parallel assistant batch before it executes any tool. A waiting `bash`,
  `edit`, or external-trigger process check would make unrelated
  `read` calls look stuck. Run reads first, then issue each checked tool in a
  later assistant step. Run `create_trigger`, `resume_trigger`, and
  `invoke_trigger` separately because each tool can start a checked process.

<!-- end:ld-119 -->

<a id="plan-mode"></a>

## Enforced plan-only mode and implementation approval (#51)

`/plan` is the readonly role applied to the authoritative main session, and
`/implement confirm` is its only exit. It is a capability gate, not a prompt
style. See the required [plan mode details](../plan-mode.md).

Reuse existing readonly enforcement in all four layers and add no second
mechanism: the restricted tool set, the shared call guard, the readonly
filesystem sandbox and readonly native Bash. Removing a schema is never
enforcement on its own. Plan mode additionally withholds `memory_edit`, MCP tool
registration and `/mcp connect|approve`, and refuses `/validation enable`: PUM
cannot certify an arbitrary server or configured command as non-mutating, so it
fails closed instead of reasoning about intent. LSP stays, document-only.

When native enforcement is unavailable, Bash fails closed with the existing
readonly reason. Never degrade it to a direct local shell in this role and never
emit the unsandboxed-continuation warning. Entering the role must still succeed
in that state, and the entry message must disclose it. Direct-user `!` Bash keeps
its configured native sandbox and stays available: the role restrains the agent,
not the user.

Record the mode twice: a companion record and an append-only, context-excluded
JSONL transition entry read on the selected ancestry. Either record restrains, so
no companion loss, crash, rollback or unreadable ancestry can return mutation,
and only an explicit user transition may append an exit record. Both transitions
use the same-file locked transaction, the same direct-user provenance boundary
and the same idle/pending/worker/goal admission gate as conversation navigation,
and a transition may fail only toward plan mode, with ownership retained. Leaving
requires a second directly typed confirmation. Headless may enter the role by
launch flag or by resuming a recorded plan-mode session, and may never leave it.
