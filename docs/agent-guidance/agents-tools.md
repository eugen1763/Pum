# Agent, goal and tool lifecycle contracts

Current mandatory implementation guidance. Read before changing orchestration, goals, caches, queues, tools, triggers or hosted search. Related current details: [subagents](../subagents.md), [goals](../goals.md), [tools](../tools.md), [search revocation](../operational-settings.md#hosted-search-and-revocation). See the [topic index](README.md).

## Bash output is summarized to a bounded head+tail view.

<a id="ld-034"></a>

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

<!-- end:ld-034 -->

## A goal is one session's durable instruction.

<a id="ld-036"></a>

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

<!-- end:ld-036 -->

## The goal judge reviews; it never works.

<a id="ld-037"></a>

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

<!-- end:ld-037 -->

## One review is one transcript row.

<a id="ld-038"></a>

- **One review is one transcript row.** The row goes up before the repository is
  read, so the wait is visible from the moment the turn settles, and it is
  rewritten in place with the outcome: completed, continuing, blocked, failed,
  discarded, cancelled, or error. Only a row still reviewing is rewritten, so the
  first outcome wins and a cancel cannot overwrite a verdict the user has read.
  Every path that drops a judge settles the row, and a start whose goal changed
  while it collected the repository state abandons its spawn rather than leaving
  a judge nobody can act on.

<!-- end:ld-038 -->

## Cancelling a turn stops the goal.

<a id="ld-039"></a>

- **Cancelling a turn stops the goal.** An abort still settles the turn, so an
  active goal would otherwise review the work the user just stopped and continue
  it. Esc stops the goal before the abort, and `/goal continue` resumes it.

<!-- end:ld-039 -->

## A child stops only its own descendants.

<a id="ld-040"></a>

- **A child stops only its own descendants.** `stop_subagent` is registered for
  managed children as well as for main, and a child's call refuses any target
  that is not below it in the spawn tree. Without it a child could neither close
  nor abandon a wedged grandchild, and `finish_subagent` refuses to complete
  while a retained descendant is open, so the agent could never finish.

<!-- end:ld-040 -->

## Goal verdicts fail closed.

<a id="ld-041"></a>

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

<!-- end:ld-041 -->

## `goalRetryLimit` bounds the loop.

<a id="ld-042"></a>

- **`goalRetryLimit` bounds the loop.** The `pum.json` setting counts consecutive
  `incomplete` verdicts, defaults to 10, accepts 0 through 100, and 0 means no
  limit. Reaching a nonzero limit fails the goal and shows the latest judge
  reason. A failed goal cannot continue.

<!-- end:ld-042 -->

## Prompt cleanup preserves every stash occurrence.

<a id="ld-049"></a>

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

<!-- end:ld-049 -->

## Message-cache tools bind ownership and routing outside model input.

<a id="ld-050"></a>

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

<!-- end:ld-050 -->

## Enter steers while the selected agent is working.

<a id="ld-080"></a>

- **Enter steers while the selected agent is working.** Main-agent input uses
  `session.steer()`. Subagent input routes through `SubagentManager`.

<!-- end:ld-080 -->

## Queued messages stay pending until insertion.

<a id="ld-081"></a>

- **Queued messages stay pending until insertion.** Steering and recipient-side
  inter-agent messages render in a dim section at the transcript bottom. A
  matching pi `message_start` moves each message into the normal transcript.

<!-- end:ld-081 -->

## Spawn preview has no pre-approval side effects.

<a id="ld-082"></a>

- **Spawn preview has no pre-approval side effects.** `spawn_subagent` with
  `preview: true` queues a requester-bound root popup. Approval calls the normal
  spawn path, then sends a non-empty note as a separate durable user message.
  Cancellation creates no child and discards the note because no recipient exists.

<!-- end:ld-082 -->

## Up recalls only queued user text.

<a id="ld-084"></a>

- **Up recalls only queued user text.** On an empty single-line selected prompt,
  Up removes the newest matching user message from the exact pi queue and pending
  transcript before restoring the text. It never recalls delivered, inter-agent,
  trigger, lifecycle, cache, acknowledgement, or image-bearing messages.

<!-- end:ld-084 -->

## Cache range execution is main-agent orchestration.

<a id="ld-086"></a>

- **Cache range execution is main-agent orchestration.** Shift+Up and Shift+Down
  select a contiguous stash range. Enter sends a generated coordination prompt
  to the main agent. The main agent can group related tasks and spawns independent
  agents in parallel. Shared project directories are the default. Close each
  agent after its completion notice arrives and its status is `completed`. Merge
  a worktree agent, or remove a shared-directory agent, unless a concrete dependency,
  conflict risk, or integration order requires waiting. Idle settlement is not
  completion. The generated prompt is authoritative execution after
  `message_cache_send`; reuse agents already assigned to its tasks and never
  create duplicate assignments.

<!-- end:ld-086 -->

## Follow-up implementation work uses available parallel capacity.

<a id="ld-089"></a>

- **Follow-up implementation work uses available parallel capacity.** Count only
  `starting` and `running` subagents toward the configured active limit. The PUM
  setting defaults to 10 and accepts values from 1 through 25. When a slot is
  available, prefer another managed subagent. Use a worktree only when isolation
  or conflict avoidance requires it. At capacity, use
  `message_agent` to queue related work for an appropriate running subagent. This
  uses the durable recipient-side message and steering queue. Never create shell
  polling or hidden queues. Never route unrelated work to an arbitrary agent. If
  no appropriate recipient is clear, state the capacity issue and keep the task
  pending for deliberate routing.

<!-- end:ld-089 -->

## Subagents are persistent background AgentSessions.

<a id="ld-090"></a>

- **Subagents are persistent background AgentSessions.** Each subagent gets an
  independent session file and shares the launch project by default. The
  `spawn_subagent` tool accepts `worktree: true` when isolated changes or conflict
  avoidance require a managed Git worktree. Spawn tools return after
  setup, not after the task. Completion becomes a custom message to the main
  agent. Shift+Tab changes only the visible transcript and input target. Ctrl+L
  opens a tree that groups each retained subagent under its spawner. The selected
  transcript owns its draft, input target, cancellation state, timer, usage
  totals, and status-bar context. Finished agents remain reusable until merge or
  removal. A successful worktree merge closes the agent, removes the worktree and
  branch, and removes its view. `worktree remove` closes a shared-directory agent
  without changing the project directory.
  Resume restores retained agents. Previously running agents become interrupted.

<!-- end:ld-090 -->

## Managed parent closure is recursive and deepest-first.

<a id="ld-091"></a>

- **Managed parent closure is recursive and deepest-first.** A managed parent
  cannot finish, merge, or be removed while any retained descendant remains at
  any depth. Every retained status blocks closure, including completed, failed,
  stopped, interrupted, idle, starting, and running. A descendant closes only
  after a successful worktree merge or valid non-force removal removes the
  registry record and any managed worktree. Managed agents cannot use force removal
  to discard failed or unmerged work. Spawn and closure checks share the
  worktree mutation queue, so a nested spawn cannot race parent closure.

<!-- end:ld-091 -->

## The main agent never polls background agents.

<a id="ld-092"></a>

- **The main agent never polls background agents.** After spawning all available
  work, the main turn ends. Completion notifications restart or steer the main
  loop. Do not use `bash sleep`, shell polling, or repeated status tool calls.

<!-- end:ld-092 -->

## `finish_subagent` sends the sole completion notice.

<a id="ld-093"></a>

- **`finish_subagent` sends the sole completion notice.** Subagents use
  `message_agent` only for questions, blockers, coordination, or actionable
  intermediate information. Never send a final summary through `message_agent`.
  The main agent must not merge or remove after a normal `Message from <agent>`
  row. Close the agent only after the completion notice arrives and the agent
  status is `completed`.
  Delivery acceptance is not acknowledgement. PUM acknowledges the stable
  settlement only after `message_start` or session inspection confirms that the
  completion notice is persisted. Managed merge authorization requires that
  acknowledged settlement and rejects every non-completed status.

<!-- end:ld-093 -->

## Idle notices report activity cycles, not completion.

<a id="ld-094"></a>

- **Idle notices report activity cycles, not completion.** A managed agent sends
  one idle notice to its direct spawner after each accepted work cycle settles.
  Durable messages and trigger steering start a cycle only after insertion.
  Lifecycle notices, acknowledgements, failed deliveries, and duplicate settle
  events do not start cycles. Persisted activity generations suppress duplicates
  after resume. An idle notice never means that an agent is ready to merge.

<!-- end:ld-094 -->

## Open-resource reminders break silent idle loops.

<a id="ld-095"></a>

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

<!-- end:ld-095 -->

## Inter-agent acknowledgements do not recurse.

<a id="ld-096"></a>

- **Inter-agent acknowledgements do not recurse.** Do not reply to acknowledgements,
  status-only messages, or completion notices unless they contain new work or a
  question. Stop any acknowledgement echo loop immediately.

<!-- end:ld-096 -->

## Inter-agent messages are durable.

<a id="ld-097"></a>

- **Inter-agent messages are durable.** The recipient gets a custom context
  message. The sender gets a display-only custom entry. Both use the normal
  transcript background and the `agentMessage` foreground; queued messages keep
  the dim foreground. The `agentMessageBg` token remains for configuration
  compatibility but does not fill transcript rows.

<!-- end:ld-097 -->

## Direct `/worktree` operations persist synthetic tool events.

<a id="ld-098"></a>

- **Direct `/worktree` operations persist synthetic tool events.** Normal agent
  tool calls already persist through pi's assistant and tool-result entries.

<!-- end:ld-098 -->

## Web search is a hosted tool bolted on outside pi's knowledge.

<a id="ld-104"></a>

- **Web search is a hosted tool bolted on outside pi's knowledge.** pi has no
  concept of provider-native tools, so `web-search.ts` wraps the `openai-codex`
  provider and appends `{type: "web_search"}` to the outgoing body through the
  documented `onPayload` hook, re-registering it with
  `runtime.registerNativeProvider()`. Historical, unversioned live observation:
  one enabled request returned citations and a disabled request used Bash instead.
  That is not a guarantee or instruction to bypass disabled search with Bash;
  hosted-tool policy is not general Bash network isolation.
  - Hosted search authorization belongs to the requesting session, not the
    global toggle or an ambient observation route. `bindSearchSession` wraps the
    trusted session stream boundary and associates each request callback with
    its exact session ID and role through a private WeakMap. Only explicitly
    bound TUI/headless main sessions and mutable workers qualify. Readonly
    workers, judges, AFK delegates, unbound requests, and unknown roles fail
    closed. Direct Check verifier completions receive no capability, even if
    they have a payload hook or run inside an authorized request's async scope.
    Extension hooks run first; the wrapper then removes denied `web_search`
    entries. Bind every new or restored runtime before its first turn. Custom
    integrations must do the same. The SDK must preserve the callback identity
    and session ID through dispatch; losing either disables hosted search.
  - `samplingParams` looks like an easier injection point but is a shallow
    `Object.assign`, so setting `tools` there would **wipe** read/write/edit/bash.
  - pi drops the returned `web_search_call` items, so logging them means reading
    the wire. Codex talks over a **WebSocket** by default and only consults a
    custom `fetch` on its HTTP path. A historical WebSocket-path probe did not
    call custom fetch; this is not a claim about HTTP/SSE fallback or all requests.
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
  - Current dispatch and retry revocation requirements are in
    [operational settings](../operational-settings.md#hosted-search-and-revocation).
    Preserve those newer boundaries as well as this provider/observer integration;
    observation is never authorization.

<!-- end:ld-104 -->

## Optional tools live in hidden per-session groups.

<a id="ld-109"></a>

- **Optional tools live in hidden per-session groups.** PUM does not send
  every custom tool schema on every request. Mutable TUI main/worker core tools
  are read, write, edit, bash, memory_read, questionnaire, history,
  get_context_remaining and new_context; main also has memory_edit, and workers
  have finish_subagent. Readonly workers omit mutation and other denied tools;
  headless and internal roles have their own restricted registrations, not this
  full TUI inventory. Admin (trigger + message-cache), Subagents, Worktree,
  Shells and Todo are hidden groups; MCP and LSP are additional main-TUI-only
  groups. All are hidden until revealed, subject to the audience allowlist;
  revealing a group never grants MCP/LSP consent. One always-present `enable_tools`
  tool (registered per session) accepts group names; its execute calls
  `setActiveToolsByName` so the group's real schemas start being sent from the
  next request onward. `state.tools` is pi's authoritative outgoing tool list
  (it flows unmodified into the request body), so narrowing it never filters
  the core loop's built-ins. Hidden tools stay in the registry but are absent
  from the model tool list until enabled. The audience allowlist defines one
  canonical outgoing tool order, independent of activation or restore order.
  `enable_tools` descriptions contain no enabled state; results report that state.
  Main and child runtimes load their own controller from the trusted session file
  before service creation registers tools, including after runtime replacement.
  Main and child sessions track their own groups independently, persisted in a
  companion file next to each session JSONL (the same pattern as the news
  companion file) so they survive
  resume and never enter LLM context. There is no News group because PUM has
  no news model tool; groups with zero tools are dropped.

<!-- end:ld-109 -->

## External triggers are process-local supervised definitions.

<a id="ld-120"></a>

- **External triggers are process-local supervised definitions.** There is no
  daemon, HTTP endpoint, socket, pipe, or file inbox. Definitions disappear on
  restart. The manager retains at most 10 definitions, 5 pending deliveries,
  and 10 fires per definition. Repeats wait at least 60 seconds; definitions
  expire after 24 hours by default and no later than 30 days. Shutdown, session
  replacement, and exact subagent unavailability terminate processes and clean
  output files.

<!-- end:ld-120 -->

## Trigger model tools bind exact targets.

<a id="ld-121"></a>

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

<!-- end:ld-121 -->

## Trigger output and templates stay inert.

<a id="ld-122"></a>

- **Trigger output and templates stay inert.** Commands use executable plus
  argv with no shell by default. The inherited environment is a small sanitized
  allowlist. Combined stdout/stderr goes to a private temporary file, drains
  after the 10 MB cap, and is removed after the triggered turn settles. Prompt
  templates accept only the documented simple `{{field}}` placeholders;
  unknown or malformed placeholders fail before process start.

<!-- end:ld-122 -->

## External-trigger checks preserve argv boundaries.

<a id="ld-123"></a>

- **External-trigger checks preserve argv boundaries.** Check mode evaluates
  `{executable, args, cwd}` as structured process data. It never flattens the
  proposal into shell text. Shell and interpreter entrypoints require embedded
  command analysis or verifier review. On-mode uses the same complete deterministic
  validation and advisory-verifier contract as other checked calls: hard blocks
  and explicit UNSAFE verdicts refuse; unavailable, unclear, failed or timed-out
  review alone does not block a fully validated call. The direct-main npm exception
  does not apply to structured processes. Abort and stale security epochs refuse.
  A blocked trigger check throws and the process never starts.

<!-- end:ld-123 -->
