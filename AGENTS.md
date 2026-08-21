# PUM

A small coding agent with a terminal UI. It wraps pi's agent loop in an OpenTUI
front end and keeps its own credentials and settings.

```
bun run login    # log in through pi, pointed at PUM's own config dir
bun run start    # open the TUI in the current directory
```

## Layout

| File | Job |
|---|---|
| `src/index.tsx` | Side-effect-free CLI dispatch for help, version, errors, and dynamic startup |
| `src/cli.ts` | CLI parsing, package metadata, help text, and error formatting |
| `src/outer-sandbox.ts` | Canonical mount validation and deterministic claudebox launch planning |
| `src/outer-sandbox-launch.ts` | PUM child command, runtime/state mounts, and outer child context |
| `src/outer-sandbox-process.ts` | Protocol probe and shell-free claudebox process execution |
| `src/main.tsx` | Boot: config dir, login hand-off, credential check, session, render |
| `src/headless.ts` | Non-interactive `-p` one-shot: core coding tools, Check mode, no UI surfaces |
| `src/app.tsx` | The TUI — state, keyboard dispatch, agent events, layout |
| `src/theme.ts` | Semantic colour tokens, nine presets, `theme.json` merge |
| `src/popup-frame.tsx` | Shared responsive popup frame and semantic drop shadow |
| `src/animation.tsx` | One frame clock; the glow core; shimmer, spinner, caret |
| `src/status-bar.tsx` | Top bar; always one measured row with responsive field priorities |
| `src/transcript.tsx` | Row rendering per role |
| `src/output-minimal.ts` | Grouping successful tool runs into one activity row |
| `src/transcript-dwell.ts` | How long a row must stay put before it may change |
| `src/transcript-window.ts` | Which rows are mounted, and when older ones join them |
| `src/tool-row.ts` | One spelling of a tool row, for live events and for replay |
| `src/tool-preview.ts` | Diff, write, and Bash previews, and inline diff trimming |
| `src/syntax-grammars.ts` | Registers the tree-sitter grammars vendored under `assets/` |
| `src/tool-line.ts` | Which argument to show, and `+n −n` from mutation patches |
| `src/questionnaire.ts` | Model tool, request queue, answer state, and main/child bridge |
| `src/tool-groups.ts` | Hidden tool groups, the `enable_tools` tool, and per-session persistence |
| `src/questionnaire-popup.tsx` | OpenTUI questionnaire popup and responsive layout |
| `src/git-branch.ts` | Reads and watches `.git/HEAD` |
| `src/syntax.ts` | Theme → `SyntaxStyle` for markdown and code highlighting |
| `src/history.ts` | Prompt-history adapter for the shared prompt cache |
| `src/prompt-stash.ts` | Prompt-stash adapter for the shared prompt cache |
| `src/prompt-cache.ts` | Reconciliation, retention, migration, and atomic persistence |
| `src/message-cache.ts` | Agent cache tools, ownership, stable IDs, and App execution bridge |
| `src/image-paste.ts` | Clipboard image capture and temporary-file lifecycle |
| `src/text-paste.ts` | Bounded local clipboard text capture for secure login fields |
| `src/pasted-text.ts` | Large or multiline prompt pastes become a `[Pasted text #n]` marker backed by a system-temp file |
| `src/clipboard.ts` | Completed text selection copy routes for native clipboards and OSC 52 |
| `src/worktree.ts` | Create, inspect, merge, and remove managed Git worktrees |
| `src/subagents/manager.ts` | Parallel agent sessions, routing, persistence, and tools |
| `src/subagents/spawn-preview.ts` | Requester-bound preview queue and approval settlement |
| `src/subagents/spawn-preview-popup.tsx` | Responsive Markdown preview and optional note input |
| `src/subagents/readonly.ts` | Fail-closed readonly child tool guard |
| `src/replay.ts` | Rebuilds transcript lines from a resumed session's entries |
| `src/queue-recall.ts` | Atomic newest-first recall of queued user messages |
| `src/session-resume-alias.ts` | Trusted source/worktree pointers to one canonical relocated session JSONL |
| `src/session-history-metadata.ts` | Bounded session JSONL metadata and usage index |
| `src/session-history-popup.tsx` | Responsive session history list and metadata rows |
| `src/settings-popup.tsx` | The Ctrl+P panel. Presentational; owns no keyboard logic |
| `src/login-popup.tsx` | Presentational provider login and custom-provider popup |
| `src/login-controller.ts` | Provider auth state machine and popup keyboard actions |
| `src/login-flow.ts` | Provider registry, custom discovery, redaction, and atomic config writes |
| `src/browser-launch.ts` | Validated direct-argv OAuth browser launch with visible fallback |
| `src/goal.ts` | Goal state, transitions, verdict validation, and atomic persistence |
| `src/goal-command.ts` | `/goal` and `/goalf` parsing |
| `src/goal-judge.ts` | Judge task, verdict schema, and bounded repository context |
| `src/goal-line.ts` | The goal label on the input-top rule |
| `src/goal-review.ts` | The inline review row: its statuses, glyphs, and colours |
| `src/settings.ts` | PUM's own `pum.json` |
| `src/check-mode.ts` | On/off Check mode for commands, mutations, and trigger processes |
| `src/check-paths.ts` | Project-scoped additional Check mode root validation and commands |
| `src/filesystem-sandbox.ts` | Process-local path boundary for file tools |
| `src/check-policy.ts` | Deterministic shell and structured-process hard rules |
| `src/check-mutation.ts` | Pre-execution edit and patch diff proposals |
| `src/check-approvals.ts` | Check mode identity model and canonical-input serializer |
| `src/bash-output.ts` | Bash output summarization: bounded head+tail view, filters, `patterns`/`full_output` args |
| `src/sandbox/types.ts` | Shared native sandbox capability, policy, and process contracts |
| `src/sandbox-policy.ts` | Canonical policy derivation, environment filtering, and fallback decisions |
| `src/sandbox/index.ts` | pi Bash override, backend selection, probing, and enforcement controller |
| `src/sandbox/linux.ts` | Linux Bubblewrap backend and direct argv construction |
| `src/sandbox/windows.ts` | Windows MXC/CreateProcessInSandbox backend and argv quoting |
| `src/triggers/manager.ts` | Process-local trigger lifecycle, limits, routing, and cleanup |
| `src/triggers/tools.ts` | Main/child trigger model tools and target authorization |
| `src/triggers/popup.tsx` | Responsive Ctrl+T trigger management popup |
| `src/writing-style.ts` | Configurable per-turn system-prompt writing guidance |
| `src/identity.ts` | PUM identity in the system prompt and pi-docs section removal, with no-op guards |
| `src/platform.ts` | Cross-platform path identities, containment, config paths, and signals |
| `src/terminal-title.ts` | Pure title formatting and best-effort deduplicated terminal updates |
| `src/config.ts` | Where the config dir lives |

## Keys

| Key | Effect |
|---|---|
| Enter | Send the prompt, or execute the command in shell command mode |
| `!` on an empty prompt | Enter shell command mode without inserting `!` into the command |
| Backspace / Esc on an empty shell command | Return to normal prompt mode |
| Up on an empty prompt | Recall the newest queued user message for the selected agent |
| Ctrl+Enter / Shift+Enter | Insert a new line |
| `\` then Enter | Insert a new line fallback |
| Alt+Enter / Ctrl+Alt+Enter | Stash the prompt without sending |
| Alt+V | Attach an image from the graphical clipboard |
| Ctrl+Backspace / Ctrl+W | Delete the previous word |
| Ctrl+H | Open session history when the terminal reports it distinctly |
| Ctrl+N | Open recent answers (News); `n` jumps to the answer, `p` to the user prompt, and `c` copies the selected answer |
| Ctrl+End on an empty prompt | Scroll to the end of the selected transcript |
| Tab | Open/close the prompt stash on empty input; complete commands or local paths otherwise |
| Shift+Up / Shift+Down | Extend a prompt-stash selection |
| Enter on a stash selection | Ask the main agent to coordinate and merge worktree subagents |
| Shift+Tab / Ctrl+Shift+Tab | Cycle agent transcripts forward/backward |
| Ctrl+L | Open the agent transcript tree; use Up/Down and Right/Enter to select |
| Esc | Once warns, twice within 2s cancels the selected agent's running turn |
| Ctrl+P | Open settings; `s` saves them as global; Esc closes, or steps back from the model list |
| Ctrl+O | Open the selected agent's todo list; `f` filters, Esc closes |
| Ctrl+T | Open process-local external triggers |
| Ctrl+C | Clear the selected non-empty draft; on an empty draft, once arms and twice within 2s quits |
| Questionnaire: ↑/↓, ←/→ or Tab, Enter, Esc | Select options, move questions, confirm, or cancel |

## Locked decisions

These were chosen deliberately. Change them only on purpose.

- **Bun** as the runtime. OpenTUI's renderer needs it.
- **CLI help and version exit before startup.** `src/index.tsx` reads package metadata, parses arguments, and dynamically imports `src/main.tsx` only for direct TUI startup (or `src/headless.ts` for `-p`). Unknown options and commands exit with code 2, but `-h`/`--help` and `-v`/`--version` print and exit 0 even when a later argument is invalid. `--` ends option parsing, so an operand may start with `-`. In `pum s`/`pum sr` the `login` keyword must come before any mount directory, so a directory genuinely named `login` stays mountable after `--`. Startup accepts `login`, `-r`/`--resume`, and `-p`/`--prompt <text>`. `pum s` and `pum sr` launch the TUI through the outer sandbox. `pum ss` probes the runtime without starting the TUI.
- **`-p` is headless.** `pum -p "<text>"` runs one prompt in `src/headless.ts` with only read, write, edit, and bash. It keeps the configured Check mode (on/off), sandbox, writing style, and explanation strength. Interactive tools (questionnaire, enable_tools, subagents, triggers, message cache) are not registered. The session persists to the normal per-directory store, so `-r` and the TUI can continue it. Headless mode does not combine with `pum s` or `pum sr` in the current launcher protocol.
- **`@earendil-works/pi-coding-agent`**, not `pi-ai` on its own. It brings the
  agent loop, session files, and the `read`/`write`/`edit`/`bash` tools. Using
  `pi-ai` alone would mean writing all of that here.
- **There is no custom patch model tool.** Use pi's `edit` tool for targeted
  file mutations. Do not register or advertise `apply_patch` as a session tool.
- **OpenTUI with React** for the UI.
- **PUM keeps its own config dir**, `~/.config/pum` (override with `PUM_DIR`).
  It does not share pi's `~/.pi/agent`, so it needs its own login. pi stores
  auth, settings, and sessions together under one directory, so this is all or
  nothing.
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
- **Login runs inside PUM.** Startup without an available provider opens the
  login popup. `/login` opens the same popup. The provider list comes from
  `ModelRuntime.getProviders()` and must not be replaced with a local allowlist.
- **Browser login uses safe direct process arguments.** PUM opens credential-free
  HTTP(S) auth and device-code URLs once per login attempt. Windows uses
  `rundll32.exe`, macOS uses `open`, and Linux uses `xdg-open`. PUM never uses a
  shell, logs an OAuth URL, persists an OAuth URL, or fails login when launch is
  unavailable. The popup keeps the URL selectable as the fallback.
- **Submitted keys never enter React labels or session data.** The login
  controller keeps secrets outside React state. The popup renders only a length
  mask. Custom keys go to PUM's `auth.json`, while `models.json` contains only
  endpoint, compatibility, and model metadata.
- **Login text paste preserves the secret boundary.** OpenTUI bracketed paste
  routes endpoint and API-key text directly to the login controller. Local
  Ctrl+V fallback uses bounded clipboard output and direct process arguments;
  remote sessions do not invoke a host clipboard command. Secret contents never
  enter React labels, logs, session entries, or error text.
- **Custom provider discovery is conservative.** PUM normalizes an HTTP(S)
  endpoint and probes only the OpenAI-compatible `/models` route. PUM does not
  infer a different API shape from a failed probe. Config writes use a temporary
  file and atomic rename.
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
- **Active Check modes can enforce a native Bash sandbox.** PUM overrides pi's
  built-in `bash` with `createBashTool` and custom `BashOperations` in
  main and managed child sessions. Check mode Off and Sandbox Off use pi's local
  backend. Auto uses Bubblewrap on Linux or MXC BaseContainer on Windows when a
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
  it can change host ACLs. The TUI/model process is never sandboxed. External
  triggers retain deterministic checks and direct argv supervision but do not use
  this backend until approved policy can cross their synchronous spawn boundary.
  A managed shell does use it: `ShellManager` is built with
  `SandboxController.shellProcessAdapter()`, so `start_shell` and Bash reach the
  same decision from the same controller, and a shell cannot run work the Bash
  tool would have confined.
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
- **No agent writes the PUM config directory.** Settings changed in the popup
  belong to the session, not to `pum.json`, and `s` in the Settings popup is the
  one deliberate promotion to global - performed by PUM itself, never through a
  tool. The deterministic layer still supports an exact-file allowance, but
  nothing grants one, so `settings.json`, `pum.json` and `theme.json` are
  blocked for the main agent and for every subagent. `auth.json`, `models.json`
  key material and session content keep their existing hard blocks, and the
  native sandbox still denies the whole config root.
- **A session can move between directories without forking.** `/worktree start`
  creates an auto-named worktree and switches the session to its own file with
  a new `cwd`, so the session id, transcript and companion state stay put and
  nothing is copied. `/worktree return` moves it back and leaves the worktree,
  its branch and any uncommitted work alone. One layer only, main agent only,
  idle only, and refused while any managed child is retained. `start` and
  `return` are reserved words, never worktree names.
- **A tool-driven move waits for the turn that asked for it.** `worktree` with
  `start` or `return` records the intent and returns; the App moves the session
  from the settle handler. The calling turn has to finish against the directory
  it began in, or the rest of it runs against roots that changed underneath.
  Managed children, mutable or not, are refused: a delegate does not get to
  move the session it is not running in.
- **The active directory is state, not `process.cwd()`.** Everything
  directory-dependent reads it, so a move rebinds by re-render. A relocated
  session keeps its source repository writable for that process only; this
  never reaches the saved `/check-path` settings.
- **Relocation fails closed on resume.** A worktree that is gone, pruned or now
  on a different branch drops the record and stays in the source repository,
  because authorizing a stale path could hand writes to a directory the user
  never chose.
- **Relocated sessions use aliases, never copied JSONL files.** The canonical
  session stays in its source session directory. A bounded pointer in the
  generated worktree's session directory makes `-r` and session history resolve
  that same file. Source subdirectories receive a source-root pointer too.
  Return removes the worktree pointer. Alias loading validates the canonical
  session, relocation identity, generated branch, and source/worktree paths;
  stale, corrupt, linked, missing, or replaced targets fail closed.
- **Session settings live beside the session.** `<session>.settings.json` holds
  only the fields that differ from global, following the same atomic-write and
  defensive-load rules as the goal and todo companions. An empty overlay deletes
  the file rather than leaving a stub beside every session. `/clear` and `/new`
  start from the global settings, because the overlay belongs to the session
  that set it.
- **Null devices and Git Bash drive paths are policy-friendly.** `/dev/null` is
  a null device in every path flavor, so `2>/dev/null` and `> /dev/null` no
  longer classify as external writes on a Windows cwd. A Git Bash / MSYS drive
  path such as `/c/Users/...` or `/d/dev/...` resolves to its native drive, so
  the session cwd, project roots, and `cd` targets share one canonical identity
  on Windows for the deterministic policy.
- **The filesystem sandbox covers file tools.** `read`, `write`, and `edit` are
  limited to the project and configured `/check-path` roots before execution.
  Credential-sensitive paths and symbolic-link or junction components
  are blocked. This is a process-local path guard, not operating-system
  isolation for bash, scripts, extensions, or trigger processes.
- **The guard validates the path the tool will actually open.** pi's `read` tool
  retries filename variants (NFD, curly apostrophe, narrow-space AM/PM), so
  checking the literal string would approve one path while the tool opened
  another. For a read, the sandbox resolves the same candidate in the same order
  and runs every check on that candidate.
- **PUM's own staged temp directories are readable, never writable.** Large
  pasted text and captured bash output live in per-process directories that PUM
  registers explicitly. Reads inside a registered root are allowed so the model
  can retrieve what it was told to read; writes there are still refused, and the
  credential rules still apply. A model-supplied temp path never matches.
- **Mutating a multiply-linked file is refused.** A hard link is an ordinary file
  to `lstat`, so containment alone cannot tell whether an in-project name aliases
  content outside the project. Writes and edits to a file with a link
  count above one are blocked; reads stay allowed, because hard links are common
  in real trees. The check cannot say where the other links point, and it is a
  check-time test rather than a guarantee against a link created afterwards.
- **Bash output is summarized to a bounded head+tail view.** `src/bash-output.ts`
  wraps pi's bash tool in main and managed child sessions. The default keeps
  first 30 / last 40 lines within 3KB, strips ANSI, drops progress-only lines,
  compresses repeated and similar runs, and re-injects FAIL/error/warning lines
  from the elided middle. PUM tees the exact stream to its own trusted private
  temp file before execution; the marker points at it whenever output is changed
  or elided. Captures live in one per-process directory created on first use, so
  the sandbox can allow reads there without opening the whole system temp
  directory; shutdown removes it. Never parse a file path from command output. The tool schema
  gains `full_output` (return pi's native output), `strategy`, `max_bytes`, and
  `patterns` (regexes whose matching lines survive elision). The `bashOutput`
  setting in `pum.json` tunes or disables it. See `research/bash-output/`.
- **Questionnaires render in PUM, not pi's default UI.** The shared controller queues main-agent and child-agent requests. The popup owns no global keyboard handler. `app.tsx` routes keys and removes prompt focus while a request is active. Custom draft text stays in the OpenTUI textarea until explicit submission.
- **A goal is one session's durable instruction.** `/goal <text>` stores it in a
  companion file beside the session JSONL and starts a turn at once. `/goalf
  <draft>` runs one interview turn that questions the user through the ordinary
  questionnaire, ends with a `GOAL:` line, and stores nothing until the user
  confirms it. Replacing, clearing, and confirming a proposal all ask first, and
  cancelling changes nothing. States are `active`, `stopped`, `blocked`,
  `completed`, and `failed`; the last two are terminal and must be replaced or
  cleared. `/goal stop` ends automation without touching running work and keeps
  any blocked question, so `/goal status` still shows what was asked; `/goal
  continue` resumes only a stopped goal and clears that question, and `/goal
  status` prints the complete state with untruncated text. A normal message steers the goal and answers a
  blocked question. `/clear` and `/new` open a session with no companion file,
  so no goal follows the user into it.
- **The goal judge reviews; it never works.** After a settled main turn PUM
  starts one fresh judge, but only when the goal is active, no managed worker is
  starting or running, no external trigger is running or waiting for delivery,
  no judge is already in flight, no queued message is still waiting for insertion,
  and this settled work generation is unjudged. Every one of those is an event,
  never a poll or a timer. The judge runs in the launch
  project with no worktree and no branch, holds only `read`, `bash`, and
  `goal_verdict`, is readonly whenever Sandbox is not Off, and is told in plain
  words not to mutate anything when it is not. It is excluded from the worker
  count, sends no completion notice, creates no News item, and is removed once
  its verdict is processed. A judge that settles without a verdict is dropped and
  reported. Restored judge records are discarded on resume.
- **One review is one transcript row.** The row goes up before the repository is
  read, so the wait is visible from the moment the turn settles, and it is
  rewritten in place with the outcome: completed, continuing, blocked, failed,
  discarded, cancelled, or error. Only a row still reviewing is rewritten, so the
  first outcome wins and a cancel cannot overwrite a verdict the user has read.
  Every path that drops a judge settles the row, and a start whose goal changed
  while it collected the repository state abandons its spawn rather than leaving
  a judge nobody can act on.
- **Cancelling a turn stops the goal.** An abort still settles the turn, so an
  active goal would otherwise review the work the user just stopped and continue
  it. Esc stops the goal before the abort, and `/goal continue` resumes it.
- **A child stops only its own descendants.** `stop_subagent` is registered for
  managed children as well as for main, and a child's call refuses any target
  that is not below it in the spawn tree. Without it a child could neither close
  nor abandon a wedged grandchild, and `finish_subagent` refuses to complete
  while a retained descendant is open, so the agent could never finish.
- **Goal verdicts fail closed.** One structured verdict decides everything.
  Goal judges are internal agents. They never appear in `list_subagents`, and
  the manager discards them after startup failure, prompt failure, or settlement.
  `completed` ends the goal with evidence. `blocked` asks the user one question
  and waits. `incomplete` queues exactly one generated continuation, which is
  delivered as a non-recallable main-agent turn. Invalid, missing, duplicated,
  and stale results start no turn at all: a stop, a replacement, a clear, a
  session switch, or a newer work generation makes an in-flight verdict stale,
  and `/goal stop` wins those races because it bumps the goal generation and
  removes the judge before it can report. The goal record is persisted before the
  action runs, and the continuation stays owed until its turn actually starts, so
  resume neither repeats a review nor delivers a continuation twice.
- **`goalRetryLimit` bounds the loop.** The `pum.json` setting counts consecutive
  `incomplete` verdicts, defaults to 10, accepts 0 through 100, and 0 means no
  limit. Reaching a nonzero limit fails the goal and shows the latest judge
  reason. A failed goal cannot continue.
- **The goal rides the input-top rule, not the status bar.** The label sits at
  the right end of the full-width rule above the prompt, takes the rule colour as
  its background and a semantic foreground per state, keeps two columns of right
  padding, and never exceeds half the rule. It truncates by terminal columns on
  grapheme boundaries and disappears rather than overflow a narrow terminal. The
  working-rule animation sweeps the whole row, label included, and the static
  behavior is unchanged when animation is off.
- **Sessions persist** to `<config dir>/sessions`.
- **Prompt cleanup preserves every stash occurrence.** Corresponding directories
  in linked Git worktrees use the primary worktree's normalized cache identity;
  non-Git directories stay isolated. For each cache identity, history also
  retains the 100 most recent sent
  occurrences not reserved by the stash. Duplicate text uses occurrence counts,
  not a set. Loads and mutations reconcile legacy keys and persist atomically.
  The stash itself is bounded per working directory (500 entries, 1M characters)
  because agent tools can add to it without limit; eviction takes the oldest
  executed entries first and never drops the newest. An exclusive lock guards the
  read-modify-write, so two PUM processes sharing a config directory cannot drop
  each other's keys; a stale lock expires and a lock that cannot be taken is
  skipped rather than failing the write.
- **Message-cache tools bind ownership and routing outside model input.** Legacy
  rows are user-owned. Agent rows store the exact creator identity and display
  name. An agent deletes only its own rows. Sends accept stable IDs and use the
  App user-execution bridge. Multi-entry sends use main-agent orchestration.
  When a user asks to run open or pending cached tasks, the main agent must call
  `message_cache_send` with stable IDs before it spawns or assigns work. Listing
  or reading cache previews is not execution. A send reserves its IDs, commits
  executed state only after successful delivery, and releases the reservation
  after failure. Multi-entry delivery creates the authoritative main-agent
  coordination prompt. When that prompt arrives, reuse already assigned agents
  and never create duplicate assignments.
- **Colours are never literals.** Everything reads a semantic token from
  `theme.ts`. Nine presets ship; `theme.json` in the config dir overrides any
  subset of tokens. Add a token rather than a hex code.
- **The status bar is always exactly one rendered row.** Narrow layouts remove
  cost, cache-read tokens, outgoing tokens, incoming tokens, then the PUM title.
  The launch directory appears immediately left of the Git branch with its own
  semantic colour and drops before higher-priority agent and branch data.
  Remaining metadata follows explicit operational priorities and Unicode column
  measurements. The status bar never wraps or switches to a stacked layout.
- **The terminal title reflects overall activity.** PUM uses OpenTUI's title API,
  writes only changed values, and counts only starting and running subagents.
  Inside tmux, the application title becomes the pane title. The outer title
  still depends on tmux `set-titles` and `set-titles-string` configuration.
- **Compact by default.** No borders around the input, no blank rows between
  turns, no padding that does not earn its place. A user turn is a full-width
  background bar; everything after it indents two columns.
- **The prompt is a wrapping multiline textarea.** Enter sends. Ctrl+Enter and
  Shift+Enter add a line. A trailing `\` plus Enter is the fallback and removes
  the `\`. It grows to eight rows, then scrolls. Word wrapping uses character
  fallback for long tokens and reserves six right columns. The `❯` gutter
  follows the cursor's visible row. Up and Down move through displayed wrapped
  rows. Home and End move within the displayed row. Ctrl+Home and Ctrl+End move
  to the prompt boundaries. Ctrl+Left and Ctrl+Right move by words. Ctrl+Up and
  Ctrl+Down move to the prompt boundaries. Ctrl+End scrolls the transcript only
  when the prompt is empty.
- **Long text pastes become attachments early.** A paste over 16 KiB or over
  three logical lines becomes a `[Pasted text #n]` marker backed by a private
  temporary file. Stack traces therefore stay compact before they fill the
  prompt. Three lines or fewer stay inline when the byte limit also permits it.
- **An empty `!` enters user shell command mode.** PUM removes the `!` from the
  command, shows `!` in the gutter, and paints both input rules with `accent`.
  Backspace or Esc exits when the command is empty. Alt+I does nothing in this
  mode. Path suggestions and Tab completion remain available. Multiline pasted
  commands and trailing-`\` newline insertion stay valid. Submission uses
  `AgentSession.executeBash()` with PUM's Bash operations, so
  Check mode does not inspect user commands but the configured native sandbox
  still applies. A running agent receives the result reaction as a steer. An
  idle agent starts a new turn after the command result enters session context.
- **Animation is on by default** and turns itself off without true colour.
- **A signal colour means one thing.** Red is errors and removed lines, green is
  success and added lines, orange is blocked. Everything else decorates: a tool
  row is `tool(first, second)` with the name, brackets and commas in `tool`
  (the preset's dim) and the arguments in `toolArg` (its accent), so the only
  signal on a settled row is the state marker at its right edge. Truncation
  notices are `dim`; they report, they do not warn. Retarget the two tokens per
  preset rather than swapping call sites, so `theme.json` keeps one knob each.
- **The three output modes differ in what they group, not in what they keep.**
  `projectTranscriptLines` is pure and reprojects the whole transcript without
  rewriting a session entry. Quiet folds every settled call into one activity
  row, including failed calls, rejected calls, commands, and mutations. Normal
  exempts bash and the mutating tools. Normal shows an editing tool's diff
  inline without being asked, capped at
  `INLINE_DIFF_CHANGED_LINES` changed lines. Verbose is the raw view: every
  call listed, every row expanded, complete retained input and result, and no
  rendered diff at all.
- **Opening a row outside Verbose is compact.** `CompactToolDetails` shows the
  result and nothing else: the tail, capped at `COMPACT_DETAIL_LINES`, with a
  count of what the cap hid. No JSON envelope, and no echo of the input the row
  above already spells out — a read row carries its own path, offset and limit,
  so an opened group of reads is exactly the list of what was read. Verbose
  keeps the raw dump, and copying a row still copies everything retained.
- **No transcript row changes faster than it can be read.** `transcript-dwell.ts`
  runs before grouping, so an activity row inherits both rules from the calls it
  folds. A tool call still running and younger than `YOUNG_ROW_MS` is not drawn
  at all, so one that settles inside that window appears already settled and
  never flickers through a running row. Any row that was drawn keeps that form
  for `MIN_VISIBLE_MS` whatever the canonical transcript does underneath. Age is
  measured from `startedAt`, not from the first render, so switching to an agent
  draws its long-running calls at once. Only the form is held; arguments, detail
  and live output update in place, except on a row whose parts all change
  together — a goal review's summary arrives with its verdict, so that row is
  held whole.
- **The live output period belongs to the call, not to the row.** It opens once
  a command has run for `LIVE_OUTPUT_DELAY_MS`, closes `MIN_VISIBLE_MS` after it
  first opened, and never reopens. The decision is made once, in the dwell
  memory, because every row remounts on an agent switch and a period restarted
  there would replay output the user already watched end.
- **One indent for everything a tool says.** Output, diffs, rejection reasons,
  opened details and an expanded group's calls all go through `DetailRow` at
  `TOOL_DETAIL_INDENT` columns, so the left edge never moves with the tool name
  and a row type added later cannot forget it.
- **Every tool row gets a blank line above it.** A run of calls reads as
  separate steps rather than a wall. Grouped activity rows and the goal review
  row carry their own too; the first row of a transcript has nothing to be
  separated from. No tool row shows a disclosure arrow — every one of them
  expands, so the glyph marked nothing. The gutter stays clickable.
- **A tool row is built once, in `tool-row.ts`.** Three paths build one — the
  main session's events, a managed child's events, and replay when a session is
  resumed — and they have to agree exactly, or a call reads one way live and
  another after a reload. `startedToolCall` and `settledToolCall` are that
  agreement, previews included: replay derives them the same way, so a mutation
  keeps its inline diff through a session load. A replayed row carries no
  `startedAt`, having no live clock to measure against.
- **A call whose turn ended without a result is interrupted, not running.**
  Replay has always shown it that way; both live paths now settle any row still
  spinning when the turn ends, so cancelling a turn leaves the same transcript a
  reload would. A `userInitiated` row is exempt: a `!` command is not part of
  the agent's turn and outlives it, and its own result owns the row when it
  finishes.
- **Reasoning is always captured and always replayed.** The display filters it
  through `transcriptForThinkingVisibility`, which is how a subagent transcript
  has always worked. Dropping it at capture or at load instead would let the
  setting reveal a resumed subagent's reasoning but never the main agent's, and
  would make turning it on show nothing until the next turn.
- **The two streamed kinds interleave, so one buffer is not enough.** A
  reasoning provider does not always finish the reasoning before the answer
  starts: the last of it can arrive after the first words of the answer.
  Committing the buffered answer to make room for that late delta cut the answer
  into two rows, which reads as a line break in the middle of a sentence — a
  live `ds4-ops` turn produced the rows `Hi! I` and `am ready to help with your
  project.` So `streamedDelta` keeps the answer streaming and appends late
  reasoning to the row it came from. Two rules follow. Every path that takes a
  delta uses `streamedDelta`, the main session and the subagent manager alike;
  and a committed reasoning row keeps its text exactly as it arrived, because
  more of it may still be appended and a trimmed space at the join would glue
  two words together. Only the answer is trimmed, because it is markdown, where
  leading whitespace opens a code block.
  `tests/interleaved-stream-ui.test.tsx` covers both rows.
- **Inter-agent messages answer to their own setting.** `showAgentMessages` is
  independent of the output mode: what one agent said to another is a different
  question from how much tool detail to show, so Verbose can hide them and Quiet
  can keep them.
- **A written file is a diff of nothing but additions.** One shape for every
  mutation, so a new file and an edited one read alike. `inlineDiffLines()`
  drops the patch envelope — `*** Begin Patch`, `@@`, `--- a/file` — because
  the row already names the file; only a patch touching several files keeps one
  heading each.
- **Revealing a row anchors its first line to the top of the viewport.** Use
  `scrollBy`, never the `scrollTop` setter: only that path marks the scroll as
  manual, and without it sticky-to-bottom pins the row straight back off the
  top of the screen as the revealed content grows beneath it.
- **Five extra tree-sitter grammars are vendored, not downloaded.** OpenTUI
  ships JavaScript, TypeScript, Markdown and Zig; `assets/tree-sitter` adds
  Python, JSON, Bash, Rust and Go so a diff highlights offline, in a sandbox,
  and on the first run. `assets/tree-sitter/README.md` records where each file
  came from and why Rust comes from a different build.
- **Every animation paints through one glow core.** A cell's strength becomes a
  colour in `glowColor()`: shaped by `GLOW_SHAPE`, blended in linear light by
  `mixLight()`, and blooming past `GLOW_KNEE` towards white. Blend in linear
  light or the middle of a ramp sags; shape the strength first or a wake of two
  percent is still visible and every trail smears the whole rule. Falloffs are
  raised cosines, not linear ramps, so no head or tail carries a corner.
  `useWorkingRule()` holds the only mutable state, a per-column wake decayed by
  `decayTrail()` on elapsed milliseconds. `ruleText()` merges equal-colour
  columns into one chunk, so a wide rule costs tens of chunks a frame and not
  one a column - anything filtering its chunks must expect runs, not cells.
- **Image markers are atomic input attachments.** Alt+V stores clipboard image
  bytes under the system temp directory and inserts `[Image #n]`. Any marker
  edit removes the full marker and file. Sending converts files to pi image
  content, then removes the temporary files.
- **Completed text selections copy on mouse release.** Local Windows and macOS
  prefer the native clipboard module, then platform commands. Local Linux uses
  display clipboard commands. SSH and Mosh use OpenTUI OSC 52, including its
  detected tmux passthrough framing. Remote OSC 52 output has a bounded payload.
- **Enter steers while the selected agent is working.** Main-agent input uses
  `session.steer()`. Subagent input routes through `SubagentManager`.
- **Queued messages stay pending until insertion.** Steering and recipient-side
  inter-agent messages render in a dim section at the transcript bottom. A
  matching pi `message_start` moves each message into the normal transcript.
- **Spawn preview has no pre-approval side effects.** `spawn_subagent` with
  `preview: true` queues a requester-bound root popup. Approval calls the normal
  spawn path, then sends a non-empty note as a separate durable user message.
  Cancellation creates no child and discards the note because no recipient exists.
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
- **Up recalls only queued user text.** On an empty single-line selected prompt,
  Up removes the newest matching user message from the exact pi queue and pending
  transcript before restoring the text. It never recalls delivered, inter-agent,
  trigger, lifecycle, cache, acknowledgement, or image-bearing messages.
- **Escape requires confirmation while working.** The first press shows a hint.
  A second press within two seconds cancels the same selected agent.
- **Cache range execution is main-agent orchestration.** Shift+Up and Shift+Down
  select a contiguous stash range. Enter sends a generated coordination prompt
  to the main agent. The main agent can group related tasks and spawns independent
  worktree agents in parallel. Merge each successful agent after its completion
  notice arrives and its status is `completed`, unless a concrete dependency,
  conflict risk, or integration order requires waiting. Idle settlement is not
  completion. The generated prompt is authoritative execution after
  `message_cache_send`; reuse agents already assigned to its tasks and never
  create duplicate assignments.
- **Follow-up implementation work uses available parallel capacity.** Count only
  `starting` and `running` subagents toward the configured active limit. The PUM
  setting defaults to 10 and accepts values from 1 through 25. When a slot is
  available, prefer another managed worktree subagent. At capacity, use
  `message_agent` to queue related work for an appropriate running subagent. This
  uses the durable recipient-side message and steering queue. Never create shell
  polling or hidden queues. Never route unrelated work to an arbitrary agent. If
  no appropriate recipient is clear, state the capacity issue and keep the task
  pending for deliberate routing.
- **Subagents are persistent background AgentSessions.** Each subagent gets a
  managed Git worktree and an independent session file. Spawn tools return after
  setup, not after the task. Completion becomes a custom message to the main
  agent. Shift+Tab changes only the visible transcript and input target. Ctrl+L
  opens a tree that groups each retained subagent under its spawner. The selected
  transcript owns its draft, input target, cancellation state, timer, usage
  totals, and status-bar context. Finished agents remain reusable until merge or
  removal. A successful managed merge closes the agent, removes the worktree and
  branch, and removes its view.
  Resume restores retained agents. Previously running agents become interrupted.
- **Managed parent closure is recursive and deepest-first.** A managed parent
  cannot finish, merge, or be removed while any retained descendant remains at
  any depth. Every retained status blocks closure, including completed, failed,
  stopped, interrupted, idle, starting, and running. A descendant closes only
  after a successful managed merge or valid non-force removal removes both its
  registry record and managed worktree. Managed agents cannot use force removal
  to discard failed or unmerged work. Spawn and closure checks share the
  worktree mutation queue, so a nested spawn cannot race parent closure.
- **The main agent never polls background agents.** After spawning all available
  work, the main turn ends. Completion notifications restart or steer the main
  loop. Do not use `bash sleep`, shell polling, or repeated status tool calls.
- **`finish_subagent` sends the sole completion notice.** Subagents use
  `message_agent` only for questions, blockers, coordination, or actionable
  intermediate information. Never send a final summary through `message_agent`.
  The main agent must not merge after a normal `Message from <agent>` row. Merge
  only after the completion notice arrives and the agent status is `completed`.
  Delivery acceptance is not acknowledgement. PUM acknowledges the stable
  settlement only after `message_start` or session inspection confirms that the
  completion notice is persisted. Managed merge authorization requires that
  acknowledged settlement and rejects every non-completed status.
- **Idle notices report activity cycles, not completion.** A managed agent sends
  one idle notice to its direct spawner after each accepted work cycle settles.
  Durable messages and trigger steering start a cycle only after insertion.
  Lifecycle notices, acknowledgements, failed deliveries, and duplicate settle
  events do not start cycles. Persisted activity generations suppress duplicates
  after resume. An idle notice never means that an agent is ready to merge.
- **Open-resource reminders break silent idle loops.** PUM counts settled turns
  separately for the main agent and each managed child while relevant retained
  descendants or nonterminal external triggers remain open. The sixth settled
  turn queues one durable `pum.agent_message` reminder with the exact open state.
  A successful reminder resets the count. The reminder-triggered turn does not
  count. No-open-resource settlement and session attachment also reset the count.
  Failed delivery keeps the threshold ready for a later settled-turn retry.
  Reminder messages never count as child activity and never create parent idle
  notices. The reminder asks for action only when appropriate and forbids an
  acknowledgement-only reply.
- **Inter-agent acknowledgements do not recurse.** Do not reply to acknowledgements,
  status-only messages, or completion notices unless they contain new work or a
  question. Stop any acknowledgement echo loop immediately.
- **Inter-agent messages are durable.** The recipient gets a custom context
  message. The sender gets a display-only custom entry. Both render with the
  `agentMessage` and `agentMessageBg` theme tokens.
- **Direct `/worktree` operations persist synthetic tool events.** Normal agent
  tool calls already persist through pi's assistant and tool-result entries.
- **`?` on an empty prompt opens the controls** instead of typing. With any
  text in the line it is an ordinary character. `help-popup.tsx` holds the
  list — keep it in step with the keyboard dispatch in `app.tsx`.
- **Assistant Markdown renders while streaming.** OpenTUI's `<markdown>` has a
  streaming mode for unstable trailing blocks. `useMarkdownCaret()` appends a
  stable caret because blinking would reparse and re-highlight the Markdown
  source. Thinking traces remain plain text so shimmer can write a `StyledText`
  directly onto one `<text>` renderable.
- **`<markdown>` and `<code>` require a `syntaxStyle` and OpenTUI ships no
  default.** `syntax.ts` builds one from the theme; it is rebuilt whenever the
  theme changes, which is what makes markdown recolour on a theme switch.
- **Style keys are tree-sitter capture names, and the dotted fallback does not
  apply on that path.** Headings are only ever captured as `markup.heading.1`
  through `.6`, so registering `markup.heading` alone leaves them at the
  default colour. Check the shipped queries in
  `@opentui/core/assets/<lang>/highlights.scm` before inventing a key.
- **Only five tree-sitter parsers ship**: javascript, typescript, markdown,
  markdown_inline, zig. Other fences render unhighlighted. `DownloadUtils` can
  fetch more at runtime if that ever becomes worth the failure path.
- **Web search is a hosted tool bolted on outside pi's knowledge.** pi has no
  concept of provider-native tools, so `web-search.ts` wraps the `openai-codex`
  provider and appends `{type: "web_search"}` to the outgoing body through the
  documented `onPayload` hook, re-registering it with
  `runtime.registerNativeProvider()`. Verified working against the live Codex
  backend: with it on, answers come back with citations; with it off, the model
  resorts to a `bash` call instead.
  - `samplingParams` looks like an easier injection point but is a shallow
    `Object.assign`, so setting `tools` there would **wipe** read/write/edit/bash.
  - pi drops the returned `web_search_call` items, so logging them means reading
    the wire. Codex talks over a **WebSocket** by default and only consults a
    custom `fetch` on its HTTP path, so there is nothing to intercept there —
    verified by probing whether a custom fetch is ever called (it is not).
    `observeSearchCalls()` therefore wraps `globalThis.WebSocket` and reads
    frames as they arrive. The observer also writes `pum.web_search` custom
    session entries, so `-r` can replay the lines without putting them in LLM
    context.
  - Do **not** "fix" this by forcing `transport: "sse"`. Cached context
    (`previous_response_id` continuation, which sends only delta input items)
    is enabled for `auto`/`websocket-cached` and not for `sse`, so that would
    resend the whole conversation every turn.
  - The wrapper delegates via `Object.create(base)` — spreading a `Provider`
    would drop its methods.
  - This is unsupported by pi and could break on upgrade. If requests start
    failing with a tool error, that is the first thing to switch off.
- **Glyphs stay plain Unicode.** Dingbats, block, box-drawing, and
  Miscellaneous Symbols only — no Nerd Font. Do not reach for a private-use
  codepoint.
- **Model and thinking level are pi's to persist.** `setModel()` and
  `setThinkingLevel()` write to `<config dir>/settings.json`, and
  `createAgentSession` reads them back at startup. Do not duplicate that here.
  `pum.json` holds only what pi does not know about, including UI preferences,
  web search, check mode, and writing style.
- **Optional tools live in hidden per-session groups.** PUM does not send
  every custom tool schema on every request. Core tools (read, write, edit,
  bash, questionnaire; finish_subagent for children) are always
  sent. The Admin (trigger + message-cache), Subagents, and Worktree groups
  are hidden until the model reveals them. One always-present `enable_tools`
  tool (registered per session) accepts group names; its execute calls
  `setActiveToolsByName` so the group's real schemas start being sent from the
  next request onward. `state.tools` is pi's authoritative outgoing tool list
  (it flows unmodified into the request body), so narrowing it never filters
  the core loop's built-ins. Hidden tools stay in the registry but are absent
  from the model tool list until enabled. Main and child sessions track their
  own groups independently, persisted in a companion file next to each
  session JSONL (the same pattern as the news companion file) so they survive
  resume and never enter LLM context. There is no News group because PUM has
  no news model tool; groups with zero tools are dropped.
- **Release publication uses npm trusted publishing.** GitHub OIDC publishes
  prereleases under `beta` and stable versions under `latest`, with npm
  provenance. The workflow does not promote prereleases to `latest` and does
  not use an `NPM_TOKEN`. Never print, persist, or expose registry credentials.
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
- **On-mode npm pack is narrow and deterministic.** PUM accepts only one direct
  `npm pack` command with lifecycle scripts disabled and an explicit cache path.
  A package operand must be one exact registry package version. Cache and pack
  destinations must resolve inside the project or an approved additional root.
  File, Git, URL, tag, range, ambiguous, credential, external-write, composed,
  and global-install forms remain blocked. This rule does not change the
  main-agent allow exception for `npm publish` or `npm dist-tag add`.
- **On-mode release installation is narrow and deterministic.** PUM accepts
  only one direct `npm install` of one exact registry package version. The
  command must include `--ignore-scripts`, an explicit `--prefix`, and an
  explicit `--cache`. Both paths must resolve inside the project or an approved
  additional root. File, Git, URL, tag, range, ambiguous, credential,
  external-write, composed, alias, global, and unsupported-option forms remain
  blocked. General package installation and lifecycle-enabled installation
  remain blocked.
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
- **Checked tools stay out of parallel mixed batches.** pi prepares every tool
  in a parallel assistant batch before it executes any tool. A waiting `bash`,
  `edit`, or external-trigger process check would make unrelated
  `read` calls look stuck. Run reads first, then issue each checked tool in a
  later assistant step. Run `create_trigger`, `resume_trigger`, and
  `invoke_trigger` separately because each tool can start a checked process.
- **External triggers are process-local supervised definitions.** There is no
  daemon, HTTP endpoint, socket, pipe, or file inbox. Definitions disappear on
  restart. The manager retains at most 10 definitions, 5 pending deliveries,
  and 10 fires per definition. Repeats wait at least 60 seconds; definitions
  expire after 24 hours by default and no later than 30 days. Shutdown, session
  replacement, and exact subagent unavailability terminate processes and clean
  output files.
- **Trigger model tools bind exact targets.** Child schemas accept only an
  omitted target or `{kind: "self"}`. Main schemas accept `main` or a retained
  subagent selector that `SubagentManager` resolves to an exact session, agent,
  and worktree. Never accept model-supplied raw `TriggerTarget` fields.
  `create_trigger`, `resume_trigger`, and `invoke_trigger` can start checked
  processes and stay out of mixed parallel batches. `invoke_trigger` accepts
  only a trigger id and always runs the configured executable. The TUI and
  model tools expose no synthetic trigger action. Persisted `fireCount` and
  `maxFires` field names remain stable for session compatibility; the UI labels
  these values as runs.
- **Trigger output and templates stay inert.** Commands use executable plus
  argv with no shell by default. The inherited environment is a small sanitized
  allowlist. Combined stdout/stderr goes to a private temporary file, drains
  after the 10 MB cap, and is removed after the triggered turn settles. Prompt
  templates accept only the documented simple `{{field}}` placeholders;
  unknown or malformed placeholders fail before process start.
- **External-trigger checks preserve argv boundaries.** Check mode evaluates
  `{executable, args, cwd}` as structured process data. It never flattens the
  proposal into shell text. Shell and interpreter entrypoints require embedded
  command analysis or verifier review. On-mode allows a structured process only
  when the deterministic policy and the advisory verifier both clear it;
  otherwise the trigger check throws and the process never starts.
- **News persists user turns and managed completion responses.** The news
  companion file stores `prompts` (`text` plus a `steer` flag) with each answer.
  Completed `finish_subagent` settlements project into the same file only after
  the direct requester produces a non-acknowledgement response. The canonical
  News id is `subagent-finish:<settlement.messageId>`. Registry reconciliation
  preserves read and answered state and prevents duplicates after resume,
  delivery retries, replay, or acknowledgement. Completion items store the
  finishing agent and direct requester names and ids. The popup renders this
  identity above the finish notice and response. `n` jumps to the requester
  response. `p` uses the stable agent-message id to jump to the completion
  notice. A normal answer is marked read only when a new user prompt follows it
  directly in the transcript. Any interleaved line leaves the answer unread.
  Resumed transcripts are tagged with News ids at launch and session switch.
  A resumed answer whose text no longer matches a replayed line stays unread by
  design. The popup copies the selected answer on `c`. Its controls stay inside
  the popup frame.

## Things that bite

Each of these cost real debugging. They are not obvious from the docs.

- **`useKeyboard` sees keys before the focused `<textarea>`**, and
  `key.stopPropagation()` keeps them from reaching it. Escape and Ctrl+P are
  unbound in the textarea, so they are safe as global shortcuts. All shortcuts
  live in the one handler in `app.tsx`.
- **Raw Ctrl+H and Backspace can both be `^H`.** OpenTUI reports that byte as
  plain Backspace. PUM keeps Backspace behavior for the ambiguous byte. Use
  `/history` when the terminal does not report Ctrl+H distinctly.
- **Two fast Ctrl+C presses arrive in one React batch**, so state read inside the
  handler is still stale on the second. The quit check compares timestamps held
  in a ref. Any keyboard rule that depends on "did this just happen" needs the
  same treatment.
- **Finish on `agent_settled`, not `agent_end`.** `agent_end` fires before an
  automatic retry, so clearing the busy flag there unlocks the input mid-run.
- **OpenTUI has no modal and no checkbox.** The popup is a `<box>` with
  `position: "absolute"` and a `zIndex`. Stacking only orders siblings, so it
  must be a direct child of the root box. Give it a background colour — an
  absolute box does not paint over what is under it.
- **`focused` is applied on change, not declared.** Drive it from a single
  expression per element (`focused={!settingsOpen}`), or focus vanishes when a
  popup unmounts and never comes back.
- **The popup's main page has no focusable children.** Rows are plain `<text>`
  and the cursor is state. That avoids the missing-checkbox problem and the
  focus juggling at once. Model pages use one `<input>` and one `<select>` with
  a single explicit focus owner.
- **`<textarea onSubmit>` receives no text value.** Read `plainText` from the
  textarea ref instead.
- **A `<text>` whose `content` is a `StyledText` measures to nothing.** It
  renders as a zero-height row unless you give it a size — `flexGrow: 1`, or an
  explicit `height` on its parent. This silently swallowed the whole status bar.
- **A whitespace-only `<text>` is not a reliable spacer.** Used as a gutter it
  measured one column narrower once the neighbouring text wrapped, so indents
  drifted between wrapped and unwrapped rows. Use a `<box>` with a *numeric*
  `width` — numeric sizes also set `flexShrink: 0`, string ones do not.
- **Never pass `content={undefined}` to an OpenTUI `<text>` from React.**
  OpenTUI 0.5.1 crashes in `setStyledText` (`text.chunks`) when a retained
  renderable's `content` changes from text to `undefined`. The working-caret
  rows hit this when a slash command set the busy state beneath an existing
  last row. Keep the value defined (an empty string works) and let the caret
  hook paint over it after React commits.
- **Auto-sized boxes shrink.** Anything that must keep its height needs
  `flexShrink: 0`, or a taller sibling steals its rows and overdraws it.
- **The scrollbar auto-shows and re-wraps everything.** Once the transcript
  passes one screen it appears, costs a column, and every message re-flows.
  `verticalScrollbarOptions={{ visible: true }}` pins it.
- **`FooterDataProvider` is not exported.** Only the `ReadonlyFooterDataProvider`
  *type* is, and the package's exports map blocks deep imports — hence
  `git-branch.ts`.
- **`SessionManager` ignores `agentDir`.** Given no explicit directory it writes
  to `~/.pi/agent/sessions/`, so PUM silently scattered its conversations
  through pi's own store. Always pass `sessionDir(cwd)` from `config.ts`, to
  both `create()` and `continueRecent()`, or resume looks in the wrong place.
- **Keyboard handlers must read state from refs, not closures.** A keypress can
  arrive before React has re-rendered, so the handler still sees the previous
  value. This bit twice: the double Ctrl+C, and Esc-to-cancel silently doing
  nothing right after a submit. `busyRef` mirrors `busy` for this reason.
  Escape confirmation also uses timestamp and selected-agent refs. Reset these
  refs when the timer expires, the selected transcript changes, or work settles.
- **Do not use `useTimeline`.** It builds a new `Timeline` every render but only
  registers the first, so it stops updating after one re-render. Animation here
  runs off a single `renderer.setFrameCallback` instead, writing `content`
  straight onto renderables so React never re-renders per frame. The clock
  holds `requestLive()` only while something animates, so idle costs nothing.
- **A context value built inline re-renders the whole transcript.** React
  answers a changed provider value by walking every fiber under the provider to
  find consumers, so a fresh object in `AnimationProvider` made one keystroke
  cost time proportional to the length of the session. Measured on a 1600-row
  transcript: 70 ms a keystroke and 43 ms an answer delta, against 24 ms and
  10 ms once the value, the rows, and the row list all keep their identity.
  Three rules hold that together, and dropping any one of them brings the cost
  back: the clock context value is memoized (`animation.tsx`); `TranscriptRow`
  is `memo` and every prop it takes is identity-stable, so the disclosure
  handler is one shared function taking the row index rather than a closure per
  row; and the row list is one memoized element, whose dependency array must
  name every value a row reads. `tests/animation-clock-context.test.tsx` guards
  the first of the three.
- **OpenTUI paints only the viewport but lays out every mounted row.** Its
  scroll box culls what it draws, so a long transcript looks cheap and is not:
  the layout pass and the render list still walk every node, on every frame that
  anything changes. 1600 rows are 23,000 renderables, which cost 70 ms a
  keystroke; at 4000 rows the tree could not be built at all. The transcript
  therefore mounts only a run of rows reaching the end (`transcript-window.ts`),
  which holds the tree near 1,200 renderables however long the session is, and
  the cost of a keystroke near 9 ms. Four rules come with it, and each one cost
  a bug to learn. Anything that scrolls to a row goes through
  `scrollToTranscriptRow`: the row is probably not in the tree, asking for it
  only schedules a render, and the frame in between is free to decide the
  reader is at the end and take the row away again, so the request has to be
  repeated until the row is drawn and the window has to be held while it waits.
  Mounting history above the viewport must be paired with the scroll correction
  that holds the reader's row still, or the screen jumps under them. That
  correction must not run when the reader has dragged the view against the top
  of the mounted rows: they are asking for the history above, and holding their
  place there shows no movement at all, which is what made the first message of
  a long session unreachable. And a row index is not a line index: successful
  tool calls fold into one activity row and hidden kinds drop out, so anything
  looking for a row matches the line against `visibleLinesRef`, never against
  the transcript. `tests/transcript-window-ui.test.tsx` and
  `tests/news-keyboard-ui.test.tsx` cover all four.
- **Windows path spelling is not identity.** A single directory can appear as a
  long path, an 8.3 short path, or with different case. Additional Check mode
  roots and mutation targets must use the shared canonical identity and
  containment helpers in `platform.ts`; raw string or `realpath()` spelling
  comparisons can reject valid roots or authorize the wrong boundary.
- **`realpathSync` and `realpath` disagree about 8.3 names.** The sync one
  leaves a short name as it found it; the async one expands it. A root
  registered through one then never matches a path resolved through the other,
  and only Windows sees it, because only Windows has short names. Go through
  `canonicalRealpathSync` / `canonicalRealpath` in `platform.ts`, which ask the
  OS. This hid two real bugs: staged pasted text and captured bash output were
  handed to the agent under a spelling PUM's own sandbox refused.
- **Windows strips a trailing space from a path component.** `repo dir ` is
  created as `repo dir`, so a case built on one cannot be reproduced there.
- **A contended exclusive create is `EPERM` on Windows, not `EEXIST`** - the
  same code a filesystem uses to say it cannot lock at all. Telling the two
  apart by whether the lock file exists is not enough on its own: a holder
  releasing between the failed create and the check looks identical. Only a
  failure that repeats means locking is unavailable.
- **Bubblewrap mount order is part of the security policy.** Add system and
  read-only mounts first, writable project roots next, and private temporary and
  denied-path masks last. Reordering these arguments can expose credentials
  through a broader earlier bind.
- **MXC availability requires the native BaseContainer tier.** Importing the
  optional SDK or receiving its AppContainer+DACL tier does not mean enforcement
  is available. Auto must warn and fall back; Require must block. Never accept
  the DACL tier because it can persist host ACL changes.
- **MXC imports must select native Windows tools before module evaluation.** MXC
  0.7 runs `whoami /user` while loading. Bun can cache the child-process
  environment before a PATH guard applies, so PUM loads the SDK while the current
  directory is Windows `System32`, then restores the authoritative directory.

## Testing a TUI

Neither the UI nor the agent loop can be checked by typechecking alone.

- **Use tmux, not raw pty capture.** `script -qec …` gives you OpenTUI's
  differential output — unreadable fragments. Instead run it detached in tmux
  and read whole rendered screens:

  ```bash
  tmux new-session -d -s t -x 100 -y 28 "cd $PWD && bun run src/index.tsx"
  tmux send-keys -t t "hello" Enter
  tmux capture-pane -t t -p        # plain text
  tmux capture-pane -t t -p -e     # with SGR codes, to check colours
  ```

  Three ways this lies to you, all of which produced confidently wrong results:

  - **A launch failure looks identical to an empty capture.** Assert the
    session survived with `tmux has-session -t "=name"` before believing
    anything.
  - **`-t name` prefix-matches other sessions.** Use `=name` for session
    targets and `name:0.0` for pane targets, and pick names that cannot
    collide — a bare `-t c` once captured an unrelated session's pane.
  - **Never pipe the app's stdout** (`| tee`). That hands the TUI a pipe
    instead of a tty and it stops rendering. Redirect stderr only.
- Layout bugs show up as column offsets, so measure rather than eyeball:
  `awk '{print match($0,/[^ ]/)-1}'` over the capture catches an indent that is
  one column out.
- To exercise streaming, thinking traces, and cancelling, point a throwaway
  `PUM_DIR` at a local OpenAI-compatible mock server through `models.json`
  (`api: "openai-completions"`, `compat.thinkingFormat: "deepseek"`, an inline
  `apiKey`). Have it stream reasoning deltas and then content slowly enough to
  interrupt. This keeps tests off the real config and off a paid model.
