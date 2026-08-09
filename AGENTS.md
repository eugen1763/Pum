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
| `src/index.tsx` | Boot: config dir, login hand-off, credential check, session, render |
| `src/app.tsx` | The TUI — state, keyboard dispatch, agent events, layout |
| `src/theme.ts` | Semantic colour tokens, three presets, `theme.json` merge |
| `src/animation.tsx` | One frame clock; shimmer, spinner, caret |
| `src/status-bar.tsx` | Top bar; one row, or two when narrow |
| `src/transcript.tsx` | Row rendering per role |
| `src/tool-line.ts` | Which argument to show, and `+n −n` from mutation patches |
| `src/apply-patch.ts` | Codex patch parser, validation, atomic commit, and pi tool |
| `src/questionnaire.ts` | Model tool, request queue, answer state, and main/child bridge |
| `src/questionnaire-popup.tsx` | OpenTUI questionnaire popup and responsive layout |
| `src/git-branch.ts` | Reads and watches `.git/HEAD` |
| `src/syntax.ts` | Theme → `SyntaxStyle` for markdown and code highlighting |
| `src/history.ts` | Prompt-history adapter for the shared prompt cache |
| `src/prompt-stash.ts` | Prompt-stash adapter for the shared prompt cache |
| `src/prompt-cache.ts` | Reconciliation, retention, migration, and atomic persistence |
| `src/message-cache.ts` | Agent cache tools, ownership, stable IDs, and App execution bridge |
| `src/image-paste.ts` | Clipboard image capture and temporary-file lifecycle |
| `src/worktree.ts` | Create, inspect, merge, and remove managed Git worktrees |
| `src/subagents/manager.ts` | Parallel agent sessions, routing, persistence, and tools |
| `src/replay.ts` | Rebuilds transcript lines from a resumed session's entries |
| `src/session-history-metadata.ts` | Bounded session JSONL metadata and usage index |
| `src/session-history-popup.tsx` | Responsive session history list and metadata rows |
| `src/settings-popup.tsx` | The Ctrl+P panel. Presentational; owns no keyboard logic |
| `src/login-popup.tsx` | Presentational provider login and custom-provider popup |
| `src/login-controller.ts` | Provider auth state machine and popup keyboard actions |
| `src/login-flow.ts` | Provider registry, custom discovery, redaction, and atomic config writes |
| `src/settings.ts` | PUM's own `pum.json` |
| `src/check-mode.ts` | Safety profiles for commands, mutations, and trigger processes |
| `src/check-policy.ts` | Deterministic shell and structured-process hard rules |
| `src/check-mutation.ts` | Pre-execution edit and patch diff proposals |
| `src/check-approvals.ts` | Exact once, session, and project approval state |
| `src/check-approval-popup.tsx` | Responsive Ask-mode approval popup |
| `src/triggers/manager.ts` | Process-local trigger lifecycle, limits, routing, and cleanup |
| `src/triggers/tools.ts` | Main/child trigger model tools and target authorization |
| `src/triggers/popup.tsx` | Responsive Ctrl+T trigger management popup |
| `src/writing-style.ts` | Configurable per-turn system-prompt writing guidance |
| `src/config.ts` | Where the config dir lives |

## Keys

| Key | Effect |
|---|---|
| Enter | Send the prompt |
| Ctrl+Enter / Shift+Enter | Insert a new line |
| `\` then Enter | Insert a new line fallback |
| Alt+Enter / Ctrl+Alt+Enter | Stash the prompt without sending |
| Alt+V | Attach an image from the graphical clipboard |
| Ctrl+Backspace / Ctrl+W | Delete the previous word |
| Ctrl+H | Open session history when the terminal reports it distinctly |
| Tab | Open/close the prompt stash on an empty input |
| Shift+Up / Shift+Down | Extend a prompt-stash selection |
| Enter on a stash selection | Ask the main agent to coordinate and merge worktree subagents |
| Shift+Tab / Ctrl+Shift+Tab | Cycle agent transcripts forward/backward |
| Ctrl+L | Open the agent transcript tree; use Up/Down and Right/Enter to select |
| Esc | Once warns, twice within 2s cancels the selected agent's running turn |
| Ctrl+P | Open settings; Esc closes, or steps back from the model list |
| Ctrl+T | Open process-local external triggers |
| Ctrl+C | Clear the selected non-empty draft; on an empty draft, once arms and twice within 2s quits |
| Questionnaire: ↑/↓, ←/→ or Tab, Enter, Esc | Select options, move questions, confirm, or cancel |

## Locked decisions

These were chosen deliberately. Change them only on purpose.

- **Bun** as the runtime. OpenTUI's renderer needs it.
- **`@earendil-works/pi-coding-agent`**, not `pi-ai` on its own. It brings the
  agent loop, session files, and the `read`/`write`/`edit`/`bash` tools. Using
  `pi-ai` alone would mean writing all of that here.
- **OpenTUI with React** for the UI.
- **PUM keeps its own config dir**, `~/.config/pum` (override with `PUM_DIR`).
  It does not share pi's `~/.pi/agent`, so it needs its own login. pi stores
  auth, settings, and sessions together under one directory, so this is all or
  nothing.
- **Login runs inside PUM.** Startup without an available provider opens the
  login popup. `/login` opens the same popup. The provider list comes from
  `ModelRuntime.getProviders()` and must not be replaced with a local allowlist.
- **Submitted keys never enter React labels or session data.** The login
  controller keeps secrets outside React state. The popup renders only a length
  mask. Custom keys go to PUM's `auth.json`, while `models.json` contains only
  endpoint, compatibility, and model metadata.
- **Custom provider discovery is conservative.** PUM normalizes an HTTP(S)
  endpoint and probes only the OpenAI-compatible `/models` route. PUM does not
  infer a different API shape from a failed probe. Config writes use a temporary
  file and atomic rename.
- **Coding tools follow the active Check mode profile.** Off mode runs without
  approval. Strict and balanced apply their verifier policies. Ask mode presents
  every checked call that passes hard rules for exact approval, unless an exact
  prior approval matches. Verifier `SAFE`, unclear, error, and unavailable
  results still require the popup. Hard blocks never open the popup. Explicit
  `UNSAFE` decisions block without the popup, except for narrowly recognized
  direct npm publish mutations from the authoritative main agent. The exception
  does not depend on the verifier category. It still requires popup approval.
  Managed subagents cannot use the exception.
- **Questionnaires render in PUM, not pi's default UI.** The shared controller queues main-agent and child-agent requests. The popup owns no global keyboard handler. `app.tsx` routes keys and removes prompt focus while a request is active. Custom draft text stays in the OpenTUI textarea until explicit submission.
- **`apply_patch` is an atomic project-local mutation tool.** It parses and
  validates the complete Codex patch before writes. It rejects traversal,
  absolute paths, escaping symlinks, conflicting paths, missing context, and
  ambiguous context. It acquires pi mutation queues for every touched path,
  stages outputs, backs up existing files, and restores all files after a
  commit failure.
- **Sessions persist** to `<config dir>/sessions`.
- **Prompt cleanup preserves every stash occurrence.** For each normalized
  working-directory identity, history also retains the 100 most recent sent
  occurrences not reserved by the stash. Duplicate text uses occurrence counts,
  not a set. Loads and mutations reconcile legacy keys and persist atomically.
- **Message-cache tools bind ownership and routing outside model input.** Legacy
  rows are user-owned. Agent rows store the exact creator identity and display
  name. An agent deletes only its own rows. Sends accept stable IDs and use the
  App user-execution bridge. Multi-entry sends use main-agent orchestration.
- **Colours are never literals.** Everything reads a semantic token from
  `theme.ts`. Nine presets ship; `theme.json` in the config dir overrides any
  subset of tokens. Add a token rather than a hex code.
- **Compact by default.** No borders around the input, no blank rows between
  turns, no padding that does not earn its place. A user turn is a full-width
  background bar; everything after it indents two columns.
- **The prompt is a wrapping multiline textarea.** Enter sends. Ctrl+Enter and
  Shift+Enter add a line. A trailing `\` plus Enter is the fallback and removes
  the `\`. It grows to eight rows, then scrolls. Wrapping reserves six right
  columns. The `❯` gutter follows the cursor's visible row.
- **Animation is on by default** and turns itself off without true colour.
- **Image markers are atomic input attachments.** Alt+V stores clipboard image
  bytes under the system temp directory and inserts `[Image #n]`. Any marker
  edit removes the full marker and file. Sending converts files to pi image
  content, then removes the temporary files.
- **Enter steers while the selected agent is working.** Main-agent input uses
  `session.steer()`. Subagent input routes through `SubagentManager`.
- **Queued messages stay pending until insertion.** Steering and recipient-side
  inter-agent messages render in a dim section at the transcript bottom. A
  matching pi `message_start` moves each message into the normal transcript.
- **Escape requires confirmation while working.** The first press shows a hint.
  A second press within two seconds cancels the same selected agent.
- **Cache range execution is main-agent orchestration.** Shift+Up and Shift+Down
  select a contiguous stash range. Enter sends a generated coordination prompt
  to the main agent. The main agent can group related tasks and spawns independent
  worktree agents in parallel. Merge each successful agent after its completion
  notice arrives and its status is `completed`, unless a concrete dependency,
  conflict risk, or integration order requires waiting. Idle settlement is not
  completion.
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
- **Idle notices report activity cycles, not completion.** A managed agent sends
  one idle notice to its direct spawner after each accepted work cycle settles.
  Durable messages and trigger steering start a cycle only after insertion.
  Lifecycle notices, acknowledgements, failed deliveries, and duplicate settle
  events do not start cycles. Persisted activity generations suppress duplicates
  after resume. An idle notice never means that an agent is ready to merge.
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
  streaming mode for unstable trailing blocks. `useMarkdownCaret()` owns its
  content and appends the blinking caret. Thinking traces remain plain text so
  shimmer can write a `StyledText` directly onto one `<text>` renderable.
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
- **Check mode has explicit profiles and deterministic hard blocks.** `strict`
  keeps fail-closed verifier behavior. `balanced` blocks only hard-rule,
  explicitly suspicious, clearly dangerous, obfuscated, malformed, or
  incompletely analyzed calls. Balanced permits ordinary complete project-local
  calls. Balanced verifier review is non-blocking after complete deterministic
  validation unless the verifier returns explicit `UNSAFE`. `ask` presents every
  checked call that passes hard rules to the user, unless an exact prior approval
  matches. A verifier `SAFE` result does not bypass the popup in Ask mode. Every
  active profile blocks project escape, escaping links or junctions, credential
  access, privilege escalation, persistence, remote-script execution, dangerous
  destructive Git, and broad deletion. Hard blocks never open the popup and
  cannot be overridden. Explicit verifier `UNSAFE` results also block without
  the popup. The only exception is a narrow deterministic match for direct
  `npm publish` or `npm dist-tag add` from the authoritative main agent. The
  verifier category does not control the match. The exception still requires
  explicit popup approval. Managed subagents remain blocked.
- **Check mode verifies complete structured proposals.** Bash requests include
  all stages, operators, pipelines, redirections, substitutions, environment
  assignments, mutation intent, and boundaries. `edit` and `apply_patch`
  requests include the proposed unified diff, changed paths, line counts,
  sensitivity flags, project containment, complete-content findings, and a
  SHA-256 digest. Invalid, stale, malformed, or incompletely analyzed requests
  block without mutation. Length alone does not block a fully validated Balanced
  call. When a Balanced verifier prompt exceeds its bound, PUM sends complete
  validation metadata and digests. PUM never silently substitutes a truncated
  raw prefix or suffix. Strict and Ask remain fail-closed for oversized verifier
  input. The verifier returns decision, category, confidence, and reason. Clear
  legacy `SAFE` and `UNSAFE` replies remain compatible. One unclear reply can
  receive one bounded adjudication under the shared 15-second watchdog.
- **Ask approvals stay exact.** Ask mode can allow one exact call, one exact
  call for the session, or one canonical exact call for the project. Project
  approvals stay outside LLM context and bind to authoritative main or child
  identity, tool, verifier model, cwd, and canonical complete input. Main and
  child identity comes from session construction, not model input or chat text.
  The store is capped. Settings can clear approvals for the current project.
  PUM never stores hard-blocked operations as approvals. PUM stores an explicit
  `UNSAFE` approval only for the recognized main-agent npm publish exception.
- **Checked tools stay out of parallel mixed batches.** pi prepares every tool
  in a parallel assistant batch before it executes any tool. A waiting `bash`,
  `edit`, `apply_patch`, or external-trigger process check would make unrelated
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
  command analysis or verifier review. Ask approvals bind to the exact target,
  model, project, and canonical process input.
- **The check cache is narrow and exact.** `check-mode-cache.json` stores at
  most 256 explicit `SAFE` decisions for simple, read-only Git inspection
  commands in strict mode. A hit matches the verifier model, cwd, and canonical
  complete `bash` input. Mutation calls never enter this cache. Project scripts,
  shell composition, output-writing options, and helper options never enter the
  cache. Cache errors degrade to misses and never replace a decision.

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
- **Auto-sized boxes shrink.** Anything that must keep its height needs
  `flexShrink: 0`, or a taller sibling steals its rows and overdraws it. The
  two-row status bar lost its rule to this.
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
