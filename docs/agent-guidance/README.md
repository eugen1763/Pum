# Agent guidance index

These topic documents are **current mandatory project guidance**, split from the root AGENTS.md for selective loading, not relaxed or archived contracts. Before editing, read every applicable topic and linked feature document; cross-cutting work must read each affected topic. If routing is unclear, consult the source map and migration inventory rather than assuming no constraint applies.

## Topic routing

| Work | Required reading |
|---|---|
| Runtime, startup, CLI, provider/auth, dependencies | [Architecture](architecture.md), [CLI](../cli.md), [configuration](../configuration.md); auth also security |
| Policy, processes, paths, credentials, consent, readonly roles, release | [Security](security.md), [Safety](../security.md), [implementation cautions](implementation-cautions.md); read linked feature details |
| Session identity, persistence, relocation, settings, context, memory, diagnostics | [Sessions and context](sessions-context.md), [operational settings](../operational-settings.md) |
| Workers, goals, caches, messages, triggers, tool schemas, search | [Agents and tools](agents-tools.md), [subagents](../subagents.md), [tools](../tools.md); security for capability changes |
| Input, transcript/replay, rendering, focus, clipboard, theme | [TUI](tui.md), [implementation cautions](implementation-cautions.md), [testing](testing.md), [controls](../controls.md), [appearance](../appearance.md); security for consent/secrets |
| File discovery | [Source layout](layout.md) |

## Authority and historical material

Backticked `src/`, `docs/`, `tests/` and `assets/` paths retained from the old
root are repository-root-relative. Markdown links resolve relative to their
containing file and are checked by the guidance tests.

Root AGENTS.md and these topic contracts are current maintainer instructions. The user-facing feature docs are current scope/usage references and supply the deeper feature boundaries linked here. Existing code and tests are evidence for resolving accidental documentation contradictions, not authority to silently remove a locked constraint. If evidence is ambiguous, flag it to the requester; make behavior changes only deliberately and with authorization.

[Historical research](historical-references.md) is explicitly non-authoritative; old proposals and benchmarks do not supersede current contracts. Historical incidents retained in implementation cautions explain current constraints; their measured numbers are not current performance promises.

## Migration coverage

The [machine-readable manifest](migration.json) maps every section and top-level bullet in AGENTS.md at c986de2 to an explicit stable anchor below. Original headings, ordinals, source line intervals and normalized SHA-256 digests retain traceability. Whitespace reflow is allowed. A preserved unit retains all original words, including sub-bullets, limits and caveats; an evidence-backed clarification is recorded separately. No original contract is intentionally dropped. The source baseline is 98,852 UTF-8 bytes / 1,309 lines, SHA-256 `2bef72c47f58a1d57bf79bb7001a83515fb64e0e9eb2cec8c3e2950ee76ce98a`.

Run `bun test tests/agent-guidance.test.ts` after guidance changes. Maintain stable IDs, source metadata and original digests; deliberate current-contract revisions must update the normalized target digest, disposition, rationale and repository evidence rather than removing coverage. Keep new contracts in the relevant topic, add an indexed anchor and appropriate behavioral tests, and keep root routing sufficient. Tests check links, complete source-unit coverage and normalized per-unit preservation; they cannot prove semantic equivalence of a rewritten contract. Independent review remains required. Root guidance has a generous 20 KiB / 260-line ceiling and must remain at most one quarter of this baseline, not an exact-size golden string.

<a id="locked-preamble"></a>

## Locked decisions

These were chosen deliberately. Change them only on purpose.

<!-- end:locked-preamble -->

## Measured migration result

On September 5, 2026 the #49 split after the direct-user Bash wording correction
measured root AGENTS.md at **15,796 UTF-8 bytes / 205 lines**, down from **98,852
bytes / 1,309 lines** at c986de2: **83,056 fewer bytes (84.02%)** and **1,104 fewer
lines (84.34%)**. Measure current
files with `wc -lc AGENTS.md docs/agent-guidance/*.md`; these recorded values are
migration evidence, not exact-size test expectations.

This reduces the always-loaded root, not the total repository documentation:
full topic text, the human index and the machine manifest add on-demand bytes.
No provider tokenizer, paid request, server-cache hit or whole-task context saving
was measured. A task that needs several topics must read them despite the cost.
All 157 original units are covered: 149 preserved and eight clarified with evidence.

## Post-migration contracts

- [Enforced plan-only mode and implementation approval (#51)](security.md#plan-mode):
  the readonly role applied to main, its fail-closed unavailable-enforcement
  behavior, dual mode records and direct-user transition gate.
- [Same-session conversation branches and rewind (#50)](sessions-context.md#conversation-branches):
  explicit direct-user navigation, current companions, canonical ownership and
  append-only failure recovery; new-file forks remain deferred.

## Original-to-current inventory

| Original section / item | Original heading | Current contract |
|---|---|---|
| Introduction  | PUM | [intro](architecture.md#intro) |
| Layout  | Layout | [layout](layout.md#layout) |
| Keys  | Keys | [keys](tui.md#keys) |
| Locked decisions  | Locked decisions | [locked-preamble](README.md#locked-preamble) |
| Locked decisions 1 | Bun | [ld-001](architecture.md#ld-001) |
| Locked decisions 2 | CLI help and version exit before startup. | [ld-002](architecture.md#ld-002) |
| Locked decisions 3 | `-p` is headless. | [ld-003](architecture.md#ld-003) |
| Locked decisions 4 | `@earendil-works/pi-coding-agent` | [ld-004](architecture.md#ld-004) |
| Locked decisions 5 | There is no custom patch model tool. | [ld-005](architecture.md#ld-005) |
| Locked decisions 6 | OpenTUI with React | [ld-006](architecture.md#ld-006) |
| Locked decisions 7 | Model fallbacks are process-local and additive. | [ld-007](architecture.md#ld-007) |
| Locked decisions 8 | pi 0.85.0 needs an explicit server dependency. | [ld-008](architecture.md#ld-008) |
| Locked decisions 9 | PUM keeps its own config dir | [ld-009](architecture.md#ld-009) |
| Locked decisions 10 | Outer sandbox commands use claudebox protocol 1. | [ld-010](security.md#ld-010) |
| Locked decisions 11 | Login runs inside PUM. | [ld-011](architecture.md#ld-011) |
| Locked decisions 12 | Browser login uses safe direct process arguments. | [ld-012](security.md#ld-012) |
| Locked decisions 13 | Submitted keys never enter React labels or session data. | [ld-013](security.md#ld-013) |
| Locked decisions 14 | Login text paste preserves the secret boundary. | [ld-014](security.md#ld-014) |
| Locked decisions 15 | Custom provider discovery is conservative. | [ld-015](architecture.md#ld-015) |
| Locked decisions 16 | Check mode is a single on/off toggle. | [ld-016](security.md#ld-016) |
| Locked decisions 17 | Active Check modes can enforce a native Bash sandbox. | [ld-017](security.md#ld-017) |
| Locked decisions 18 | Additional Check mode paths are explicit and project-scoped. | [ld-018](security.md#ld-018) |
| Locked decisions 19 | Generic agent tools do not write the PUM config directory. | [ld-019](security.md#ld-019) |
| Locked decisions 20 | Project memory is agent-managed private state. | [ld-020](sessions-context.md#ld-020) |
| Locked decisions 21 | A session can move between directories without forking. | [ld-021](sessions-context.md#ld-021) |
| Locked decisions 22 | A tool-driven move waits for the turn that asked for it. | [ld-022](sessions-context.md#ld-022) |
| Locked decisions 23 | The active directory is state, not `process.cwd()`. | [ld-023](sessions-context.md#ld-023) |
| Locked decisions 24 | Relocation fails closed on resume. | [ld-024](sessions-context.md#ld-024) |
| Locked decisions 25 | Relocated sessions use aliases, never copied JSONL files. | [ld-025](sessions-context.md#ld-025) |
| Locked decisions 26 | Session settings live beside the session. | [ld-026](sessions-context.md#ld-026) |
| Locked decisions 27 | Null devices and Git Bash drive paths are policy-friendly. | [ld-027](security.md#ld-027) |
| Locked decisions 28 | The filesystem sandbox covers file tools. | [ld-028](security.md#ld-028) |
| Locked decisions 29 | The guard validates the path the tool will actually open. | [ld-029](security.md#ld-029) |
| Locked decisions 30 | PUM's own staged temp directories are readable, never writable. | [ld-030](security.md#ld-030) |
| Locked decisions 31 | Mutating a multiply-linked file is refused. | [ld-031](security.md#ld-031) |
| Locked decisions 32 | File checkpoints export recovery copies, never rewind originals. | [ld-032](security.md#ld-032) |
| Locked decisions 33 | Automatic validation requires direct-user runtime approval. | [ld-033](security.md#ld-033) |
| Locked decisions 34 | Bash output is summarized to a bounded head+tail view. | [ld-034](agents-tools.md#ld-034) |
| Locked decisions 35 | Questionnaires render in PUM, not pi's default UI. | [ld-035](tui.md#ld-035) |
| Locked decisions 36 | A goal is one session's durable instruction. | [ld-036](agents-tools.md#ld-036) |
| Locked decisions 37 | The goal judge reviews; it never works. | [ld-037](agents-tools.md#ld-037) |
| Locked decisions 38 | One review is one transcript row. | [ld-038](agents-tools.md#ld-038) |
| Locked decisions 39 | Cancelling a turn stops the goal. | [ld-039](agents-tools.md#ld-039) |
| Locked decisions 40 | A child stops only its own descendants. | [ld-040](agents-tools.md#ld-040) |
| Locked decisions 41 | Goal verdicts fail closed. | [ld-041](agents-tools.md#ld-041) |
| Locked decisions 42 | `goalRetryLimit` bounds the loop. | [ld-042](agents-tools.md#ld-042) |
| Locked decisions 43 | The goal rides the input-top rule, not the status bar. | [ld-043](tui.md#ld-043) |
| Locked decisions 44 | Context tools belong to the active session. | [ld-044](sessions-context.md#ld-044) |
| Locked decisions 45 | Context calibration is runtime-local and approximate. | [ld-045](sessions-context.md#ld-045) |
| Locked decisions 46 | Request diagnostics are opt-in and ephemeral. | [ld-046](sessions-context.md#ld-046) |
| Locked decisions 47 | Sessions persist | [ld-047](sessions-context.md#ld-047) |
| Locked decisions 48 | Mutable sessions have one process owner. | [ld-048](sessions-context.md#ld-048) |
| Locked decisions 49 | Prompt cleanup preserves every stash occurrence. | [ld-049](agents-tools.md#ld-049) |
| Locked decisions 50 | Message-cache tools bind ownership and routing outside model input. | [ld-050](agents-tools.md#ld-050) |
| Locked decisions 51 | Colours are never literals. | [ld-051](tui.md#ld-051) |
| Locked decisions 52 | The status bar is always exactly one rendered row. | [ld-052](tui.md#ld-052) |
| Locked decisions 53 | The terminal title reflects overall activity. | [ld-053](tui.md#ld-053) |
| Locked decisions 54 | Compact by default. | [ld-054](tui.md#ld-054) |
| Locked decisions 55 | The prompt is a wrapping multiline textarea. | [ld-055](tui.md#ld-055) |
| Locked decisions 56 | Printable typing restores prompt focus. | [ld-056](tui.md#ld-056) |
| Locked decisions 57 | The prompt cursor uses terminal-native blinking. | [ld-057](tui.md#ld-057) |
| Locked decisions 58 | Long text pastes stay in memory. | [ld-058](tui.md#ld-058) |
| Locked decisions 59 | An empty `!` enters user shell command mode. | [ld-059](tui.md#ld-059) |
| Locked decisions 60 | Animation is on by default | [ld-060](tui.md#ld-060) |
| Locked decisions 61 | A signal colour means one thing. | [ld-061](tui.md#ld-061) |
| Locked decisions 62 | The three output modes differ in what they group, not in what they keep. | [ld-062](tui.md#ld-062) |
| Locked decisions 63 | Opening a row outside Verbose is compact. | [ld-063](tui.md#ld-063) |
| Locked decisions 64 | No transcript row changes faster than it can be read. | [ld-064](tui.md#ld-064) |
| Locked decisions 65 | The live output period belongs to the call, not to the row. | [ld-065](tui.md#ld-065) |
| Locked decisions 66 | One indent for everything a tool says. | [ld-066](tui.md#ld-066) |
| Locked decisions 67 | Every tool row gets a blank line above it. | [ld-067](tui.md#ld-067) |
| Locked decisions 68 | A tool row is built once, in `tool-row.ts`. | [ld-068](tui.md#ld-068) |
| Locked decisions 69 | Bash transcript rows keep the complete command. | [ld-069](tui.md#ld-069) |
| Locked decisions 70 | A call whose turn ended without a result is interrupted, not running. | [ld-070](tui.md#ld-070) |
| Locked decisions 71 | Reasoning is always captured and always replayed. | [ld-071](tui.md#ld-071) |
| Locked decisions 72 | The two streamed kinds interleave, so one buffer is not enough. | [ld-072](tui.md#ld-072) |
| Locked decisions 73 | Inter-agent messages answer to their own setting. | [ld-073](tui.md#ld-073) |
| Locked decisions 74 | A written file is a diff of nothing but additions. | [ld-074](tui.md#ld-074) |
| Locked decisions 75 | Revealing a row anchors its first line to the top of the viewport. | [ld-075](tui.md#ld-075) |
| Locked decisions 76 | Five extra tree-sitter grammars are vendored, not downloaded. | [ld-076](tui.md#ld-076) |
| Locked decisions 77 | Every animation paints through one glow core. | [ld-077](tui.md#ld-077) |
| Locked decisions 78 | Image markers are atomic input attachments. | [ld-078](tui.md#ld-078) |
| Locked decisions 79 | Completed text selections copy on mouse release. | [ld-079](tui.md#ld-079) |
| Locked decisions 80 | Enter steers while the selected agent is working. | [ld-080](agents-tools.md#ld-080) |
| Locked decisions 81 | Queued messages stay pending until insertion. | [ld-081](agents-tools.md#ld-081) |
| Locked decisions 82 | Spawn preview has no pre-approval side effects. | [ld-082](agents-tools.md#ld-082) |
| Locked decisions 83 | Readonly subagents require Sandbox Auto or Require. | [ld-083](security.md#ld-083) |
| Locked decisions 84 | Up recalls only queued user text. | [ld-084](agents-tools.md#ld-084) |
| Locked decisions 85 | Escape requires confirmation while working. | [ld-085](tui.md#ld-085) |
| Locked decisions 86 | Cache range execution is main-agent orchestration. | [ld-086](agents-tools.md#ld-086) |
| Locked decisions 87 | Operational state does not rewrite the system prefix. | [ld-087](sessions-context.md#ld-087) |
| Locked decisions 88 | Security relaxation waits for all affected runtimes to settle. | [ld-088](security.md#ld-088) |
| Locked decisions 89 | Follow-up implementation work uses available parallel capacity. | [ld-089](agents-tools.md#ld-089) |
| Locked decisions 90 | Subagents are persistent background AgentSessions. | [ld-090](agents-tools.md#ld-090) |
| Locked decisions 91 | Managed parent closure is recursive and deepest-first. | [ld-091](agents-tools.md#ld-091) |
| Locked decisions 92 | The main agent never polls background agents. | [ld-092](agents-tools.md#ld-092) |
| Locked decisions 93 | `finish_subagent` sends the sole completion notice. | [ld-093](agents-tools.md#ld-093) |
| Locked decisions 94 | Idle notices report activity cycles, not completion. | [ld-094](agents-tools.md#ld-094) |
| Locked decisions 95 | Open-resource reminders break silent idle loops. | [ld-095](agents-tools.md#ld-095) |
| Locked decisions 96 | Inter-agent acknowledgements do not recurse. | [ld-096](agents-tools.md#ld-096) |
| Locked decisions 97 | Inter-agent messages are durable. | [ld-097](agents-tools.md#ld-097) |
| Locked decisions 98 | Direct `/worktree` operations persist synthetic tool events. | [ld-098](agents-tools.md#ld-098) |
| Locked decisions 99 | `?` on an empty prompt opens the controls | [ld-099](tui.md#ld-099) |
| Locked decisions 100 | Assistant Markdown renders while streaming. | [ld-100](tui.md#ld-100) |
| Locked decisions 101 | `<markdown>` and `<code>` require a `syntaxStyle` and OpenTUI ships no default. | [ld-101](tui.md#ld-101) |
| Locked decisions 102 | Style keys are tree-sitter capture names, and the dotted fallback does not apply on that path. | [ld-102](tui.md#ld-102) |
| Locked decisions 103 | Only five tree-sitter parsers ship | [ld-103](tui.md#ld-103) |
| Locked decisions 104 | Web search is a hosted tool bolted on outside pi's knowledge. | [ld-104](agents-tools.md#ld-104) |
| Locked decisions 105 | Interface icons lead their associated text. | [ld-105](tui.md#ld-105) |
| Locked decisions 106 | Glyphs stay plain Unicode. | [ld-106](tui.md#ld-106) |
| Locked decisions 107 | `/model` and `/effort` use the main session's Settings APIs. | [ld-107](sessions-context.md#ld-107) |
| Locked decisions 108 | Model and thinking level are pi's to persist. | [ld-108](sessions-context.md#ld-108) |
| Locked decisions 109 | Optional tools live in hidden per-session groups. | [ld-109](agents-tools.md#ld-109) |
| Locked decisions 110 | Idle consent uses exact-runtime activity, not App busy or SDK session flags alone. | [ld-110](security.md#ld-110) |
| Locked decisions 111 | Direct-user command authority belongs to the draft origin. | [ld-111](security.md#ld-111) |
| Locked decisions 112 | MCP is an explicitly approved main-TUI capability. | [ld-112](security.md#ld-112) |
| Locked decisions 113 | LSP is an explicitly approved main-TUI document diagnostics capability. | [ld-113](security.md#ld-113) |
| Locked decisions 114 | Release publication uses npm trusted publishing. | [ld-114](security.md#ld-114) |
| Locked decisions 115 | Check mode on has deterministic hard blocks and advisory verifier review. | [ld-115](security.md#ld-115) |
| Locked decisions 116 | On-mode npm pack is narrow and deterministic. | [ld-116](security.md#ld-116) |
| Locked decisions 117 | On-mode release installation is narrow and deterministic. | [ld-117](security.md#ld-117) |
| Locked decisions 118 | Check mode verifies complete structured proposals. | [ld-118](security.md#ld-118) |
| Locked decisions 119 | Checked tools stay out of parallel mixed batches. | [ld-119](security.md#ld-119) |
| Locked decisions 120 | External triggers are process-local supervised definitions. | [ld-120](agents-tools.md#ld-120) |
| Locked decisions 121 | Trigger model tools bind exact targets. | [ld-121](agents-tools.md#ld-121) |
| Locked decisions 122 | Trigger output and templates stay inert. | [ld-122](agents-tools.md#ld-122) |
| Locked decisions 123 | External-trigger checks preserve argv boundaries. | [ld-123](agents-tools.md#ld-123) |
| Locked decisions 124 | News persists user turns and managed completion responses. | [ld-124](tui.md#ld-124) |
| Things that bite  | Things that bite | [bites-preamble](implementation-cautions.md#bites-preamble) |
| Things that bite 1 | `useKeyboard` sees keys before the focused `<textarea>` | [bite-001](implementation-cautions.md#bite-001) |
| Things that bite 2 | Raw Ctrl+H and Backspace can both be `^H`. | [bite-002](implementation-cautions.md#bite-002) |
| Things that bite 3 | Two fast Ctrl+C presses arrive in one React batch | [bite-003](implementation-cautions.md#bite-003) |
| Things that bite 4 | Finish on `agent_settled`, not `agent_end`. | [bite-004](implementation-cautions.md#bite-004) |
| Things that bite 5 | OpenTUI has no modal and no checkbox. | [bite-005](implementation-cautions.md#bite-005) |
| Things that bite 6 | `focused` is applied on change, not declared. | [bite-006](implementation-cautions.md#bite-006) |
| Things that bite 7 | The popup's main page has no focusable children. | [bite-007](implementation-cautions.md#bite-007) |
| Things that bite 8 | `<textarea onSubmit>` receives no text value. | [bite-008](implementation-cautions.md#bite-008) |
| Things that bite 9 | A `<text>` whose `content` is a `StyledText` measures to nothing. | [bite-009](implementation-cautions.md#bite-009) |
| Things that bite 10 | A whitespace-only `<text>` is not a reliable spacer. | [bite-010](implementation-cautions.md#bite-010) |
| Things that bite 11 | Never pass `content={undefined}` to an OpenTUI `<text>` from React. | [bite-011](implementation-cautions.md#bite-011) |
| Things that bite 12 | Auto-sized boxes shrink. | [bite-012](implementation-cautions.md#bite-012) |
| Things that bite 13 | The scrollbar auto-shows and re-wraps everything. | [bite-013](implementation-cautions.md#bite-013) |
| Things that bite 14 | `FooterDataProvider` is not exported. | [bite-014](implementation-cautions.md#bite-014) |
| Things that bite 15 | `SessionManager` ignores `agentDir`. | [bite-015](implementation-cautions.md#bite-015) |
| Things that bite 16 | Keyboard handlers must read state from refs, not closures. | [bite-016](implementation-cautions.md#bite-016) |
| Things that bite 17 | Do not use `useTimeline`. | [bite-017](implementation-cautions.md#bite-017) |
| Things that bite 18 | A context value built inline re-renders the whole transcript. | [bite-018](implementation-cautions.md#bite-018) |
| Things that bite 19 | OpenTUI paints only the viewport but lays out every mounted row. | [bite-019](implementation-cautions.md#bite-019) |
| Things that bite 20 | Windows path spelling is not identity. | [bite-020](implementation-cautions.md#bite-020) |
| Things that bite 21 | `realpathSync` and `realpath` disagree about 8.3 names. | [bite-021](implementation-cautions.md#bite-021) |
| Things that bite 22 | Windows strips a trailing space from a path component. | [bite-022](implementation-cautions.md#bite-022) |
| Things that bite 23 | A contended exclusive create is `EPERM` on Windows, not `EEXIST` | [bite-023](implementation-cautions.md#bite-023) |
| Things that bite 24 | An atomic rename can fail briefly on Windows. | [bite-024](implementation-cautions.md#bite-024) |
| Things that bite 25 | Bubblewrap mount order is part of the security policy. | [bite-025](implementation-cautions.md#bite-025) |
| Things that bite 26 | MXC availability requires the native BaseContainer tier. | [bite-026](implementation-cautions.md#bite-026) |
| Things that bite 27 | MXC imports must select native Windows tools before module evaluation. | [bite-027](implementation-cautions.md#bite-027) |
| Testing a TUI  | Testing a TUI | [testing](testing.md#testing) |
