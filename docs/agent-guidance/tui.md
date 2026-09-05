# TUI interaction and rendering contracts

Current mandatory implementation guidance. Read before changing UI, input, transcript/replay, rendering or clipboard behavior. Also read [implementation cautions](implementation-cautions.md), [TUI testing](testing.md), [appearance](../appearance.md) and [controls](../controls.md). See the [topic index](README.md).

<a id="keys"></a>

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
| Enter on a stash selection | Ask the main agent to coordinate subagents and merge optional worktrees |
| Shift+Tab / Ctrl+Shift+Tab | Cycle agent transcripts forward/backward |
| Ctrl+L | Open the agent transcript tree; use Up/Down and Right/Enter to select |
| Esc | Once warns, twice within 2s cancels the selected agent's running turn |
| Ctrl+P | Open settings; `s` saves them as global; Esc closes, or steps back from the model list |
| Ctrl+O | Open the selected agent's todo list; `f` filters, Esc closes |
| Ctrl+T | Open process-local external triggers |
| Ctrl+C | Clear the selected non-empty draft; on an empty draft, once arms and twice within 2s quits |
| Questionnaire: ↑/↓, ←/→ or Tab, Enter, Esc | Select options, move questions, confirm, or cancel |

<!-- end:keys -->

The original key table and prompt rules below summarize **normal input mode**.
The current [controls](../controls.md) also document Alt+I multiline input mode:
Enter inserts a newline there; shell mode keeps its separate behavior. The table
is not an instruction to remove this existing mode (`src/app.tsx` inputModeRef).

## Questionnaires render in PUM, not pi's default UI.

<a id="ld-035"></a>

- **Questionnaires render in PUM, not pi's default UI.** The shared controller queues main-agent and child-agent requests. The popup owns no global keyboard handler. `app.tsx` routes keys and removes prompt focus while a request is active. Custom draft text stays in the OpenTUI textarea until explicit submission.

<!-- end:ld-035 -->

## The goal rides the input-top rule, not the status bar.

<a id="ld-043"></a>

- **The goal rides the input-top rule, not the status bar.** The label sits at
  the right end of the full-width rule above the prompt, takes the rule colour as
  its background and a semantic foreground per state, keeps two columns of right
  padding, and never exceeds half the rule. It truncates by terminal columns on
  grapheme boundaries and disappears rather than overflow a narrow terminal. The
  working-rule animation sweeps the whole row, label included, and the static
  behavior is unchanged when animation is off.

<!-- end:ld-043 -->

## Colours are never literals.

<a id="ld-051"></a>

- **Colours are never literals.** Everything reads a semantic token from
  `theme.ts`. Nine presets ship; `theme.json` in the config dir overrides any
  subset of tokens. Add a token rather than a hex code.

<!-- end:ld-051 -->

## The status bar is always exactly one rendered row.

<a id="ld-052"></a>

- **The status bar is always exactly one rendered row.** Narrow layouts remove
  cost, cache-read tokens, outgoing tokens, incoming tokens, then the PUM title.
  The launch directory appears immediately left of the Git branch with its own
  semantic colour and drops before higher-priority agent and branch data.
  Remaining metadata follows explicit operational priorities and Unicode column
  measurements. The status bar never wraps or switches to a stacked layout.

<!-- end:ld-052 -->

## The terminal title reflects overall activity.

<a id="ld-053"></a>

- **The terminal title reflects overall activity.** PUM uses OpenTUI's title API,
  writes only changed values, and counts only starting and running subagents.
  Inside tmux, the application title becomes the pane title. The outer title
  still depends on tmux `set-titles` and `set-titles-string` configuration.

<!-- end:ld-053 -->

## Compact by default.

<a id="ld-054"></a>

- **Compact by default.** No borders around the input, no blank rows between
  turns, no padding that does not earn its place. A user turn is a full-width
  background bar; everything after it indents two columns.

<!-- end:ld-054 -->

## The prompt is a wrapping multiline textarea.

<a id="ld-055"></a>

- **The prompt is a wrapping multiline textarea.** Enter sends. Ctrl+Enter and
  Shift+Enter add a line. A trailing `\` plus Enter is the fallback and removes
  the `\`. It grows to eight rows, then scrolls. Word wrapping uses character
  fallback for long tokens and reserves six right columns. The `❯` gutter
  follows the cursor's visible row. Up and Down move through displayed wrapped
  rows. Home and End move within the displayed row. Ctrl+Home and Ctrl+End move
  to the prompt boundaries. Ctrl+Left and Ctrl+Right move by words. Ctrl+Up and
  Ctrl+Down move to the prompt boundaries. Ctrl+End scrolls the transcript only
  when the prompt is empty.

<!-- end:ld-055 -->

## Printable typing restores prompt focus.

<a id="ld-056"></a>

- **Printable typing restores prompt focus.** With no popup open, a printable
  key returns from transcript focus or native blur to the selected agent's draft
  and inserts its exact text once at the existing cursor. This includes `/`,
  punctuation, and Unicode. Ctrl, Alt, navigation, and control keys retain their
  handlers. Transcript navigation uses arrows and Enter, not j/k/c. Popup fields
  keep typing ownership, including login secrets. Empty `?` still opens controls;
  empty `!` still enters shell command mode. Focus recovery stops propagation
  before focusing and inserts explicitly to prevent duplicate key delivery.

<!-- end:ld-056 -->

## The prompt cursor uses terminal-native blinking.

<a id="ld-057"></a>

- **The prompt cursor uses terminal-native blinking.** Keep OpenTUI's cursor
  logically visible while the prompt is focused; never toggle `showCursor` from
  PUM's animation clock. A manually hidden cursor lets animated frame writes
  become its last terminal position, so smooth cursor trails jump between the
  animation and the input when it is shown again. Native blinking also avoids
  keeping the renderer live on an otherwise idle screen.

<!-- end:ld-057 -->

## Long text pastes stay in memory.

<a id="ld-058"></a>

- **Long text pastes stay in memory.** A paste over 16 KiB or over three logical
  lines becomes a `[Pasted text #n]` editor marker with an in-memory payload.
  Sending expands the original marker spans once into literal full text for the
  transcript, model context, and history. Payloads never become temp files or
  read instructions. Marker-like text and replacement tokens inside a payload
  stay literal. Edited markers release their payloads. Failed delivery restores
  the draft when the selected input is still empty. Pending pasted attachments
  still block agent/session switching and stash insertion. No post-turn payload
  registry is needed. Three lines or fewer stay inline within the byte limit.

<!-- end:ld-058 -->

## An empty `!` enters user shell command mode.

<a id="ld-059"></a>

- **An empty `!` enters user shell command mode.** PUM removes the `!` from the
  command, shows `!` in the gutter, and paints both input rules with `accent`.
  Backspace or Esc exits when the command is empty. Alt+I does nothing in this
  mode. Path suggestions and Tab completion remain available. Multiline pasted
  commands and trailing-`\` newline insertion stay valid. Submission uses
  `AgentSession.executeBash()` with PUM's Bash operations, so
  Check mode does not inspect user commands but the configured native sandbox
  still applies. A running agent receives the result reaction as a steer. An
  idle agent starts a new turn after the command result enters session context.

<!-- end:ld-059 -->

## Animation is on by default

<a id="ld-060"></a>

- **Animation is on by default** and turns itself off without true colour.

<!-- end:ld-060 -->

## A signal colour means one thing.

<a id="ld-061"></a>

- **A signal colour means one thing.** Red is errors and removed lines, green is
  success and added lines, orange is blocked. Everything else decorates: a tool
  row is `tool(first, second)` with the name, brackets and commas in `tool`
  (the preset's dim) and the arguments in `toolArg` (its accent), so the only
  signal on a settled row is the leading state marker in its two-column gutter. Truncation
  notices are `dim`; they report, they do not warn. Retarget the two tokens per
  preset rather than swapping call sites, so `theme.json` keeps one knob each.

<!-- end:ld-061 -->

## The three output modes differ in what they group, not in what they keep.

<a id="ld-062"></a>

- **The three output modes differ in what they group, not in what they keep.**
  `projectTranscriptLines` is pure and reprojects the whole transcript without
  rewriting a session entry. Quiet folds every settled call into one activity
  row, including failed calls, rejected calls, commands, and mutations. Normal
  exempts bash and the mutating tools. Normal automatically shows the Bash
  output tail in at most five visual terminal rows, using native wrapping and
  updating the tail after resize. Settled calls use retained results; running
  calls keep the dwell layer's live-output gate. Opening a row replaces this
  automatic tail with the existing expanded details. Normal shows an editing tool's diff
  inline without being asked, capped at
  `INLINE_DIFF_CHANGED_LINES` changed lines. Verbose is the raw view: every
  call listed, every row expanded, complete retained input and result, and no
  rendered diff at all.

<!-- end:ld-062 -->

## Opening a row outside Verbose is compact.

<a id="ld-063"></a>

- **Opening a row outside Verbose is compact.** `CompactToolDetails` shows the
  result and nothing else: the tail, capped at `COMPACT_DETAIL_LINES`, with a
  count of what the cap hid. No JSON envelope, and no echo of the input the row
  above already spells out — a read row carries its own path, offset and limit,
  so an opened group of reads is exactly the list of what was read. Verbose
  keeps the raw dump, and copying a row still copies everything retained.

<!-- end:ld-063 -->

## No transcript row changes faster than it can be read.

<a id="ld-064"></a>

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

<!-- end:ld-064 -->

## The live output period belongs to the call, not to the row.

<a id="ld-065"></a>

- **The live output period belongs to the call, not to the row.** It opens once
  a command has run for `LIVE_OUTPUT_DELAY_MS`, closes `MIN_VISIBLE_MS` after it
  first opened, and never reopens. The decision is made once, in the dwell
  memory, because every row remounts on an agent switch and a period restarted
  there would replay output the user already watched end.

<!-- end:ld-065 -->

## One indent for everything a tool says.

<a id="ld-066"></a>

- **One indent for everything a tool says.** Output, diffs, rejection reasons,
  opened details and an expanded group's calls all go through `DetailRow` at
  `TOOL_DETAIL_INDENT` columns, so the left edge never moves with the tool name
  and a row type added later cannot forget it.

<!-- end:ld-066 -->

## Every tool row gets a blank line above it.

<a id="ld-067"></a>

- **Every tool row gets a blank line above it.** A run of calls reads as
  separate steps rather than a wall. Grouped activity rows and the goal review
  row carry their own too; the first row of a transcript has nothing to be
  separated from. No tool row shows a disclosure arrow — every one of them
  expands, so the glyph marked nothing. The gutter stays clickable.

<!-- end:ld-067 -->

## A tool row is built once, in `tool-row.ts`.

<a id="ld-068"></a>

- **A tool row is built once, in `tool-row.ts`.** Three paths build one — the
  main session's events, a managed child's events, and replay when a session is
  resumed — and they have to agree exactly, or a call reads one way live and
  another after a reload. `startedToolCall` and `settledToolCall` are that
  agreement, previews included: replay derives them the same way, so a mutation
  keeps its inline diff through a session load. A replayed row carries no
  `startedAt`, having no live clock to measure against.

<!-- end:ld-068 -->

## Bash transcript rows keep the complete command.

<a id="ld-069"></a>

- **Bash transcript rows keep the complete command.** `toolArgs` normalizes
  line endings and retains every command line. Main, child, and replayed user
  shell commands use the same formatter. Headless progress escapes line breaks
  so each tool notice stays on one terminal row.

<!-- end:ld-069 -->

## A call whose turn ended without a result is interrupted, not running.

<a id="ld-070"></a>

- **A call whose turn ended without a result is interrupted, not running.**
  Replay has always shown it that way; both live paths now settle any row still
  spinning when the turn ends, so cancelling a turn leaves the same transcript a
  reload would. A `userInitiated` row is exempt: a `!` command is not part of
  the agent's turn and outlives it, and its own result owns the row when it
  finishes.

<!-- end:ld-070 -->

## Reasoning is always captured and always replayed.

<a id="ld-071"></a>

- **Reasoning is always captured and always replayed.** The display filters it
  through `transcriptForThinkingVisibility`, which is how a subagent transcript
  has always worked. Dropping it at capture or at load instead would let the
  setting reveal a resumed subagent's reasoning but never the main agent's, and
  would make turning it on show nothing until the next turn.

<!-- end:ld-071 -->

## The two streamed kinds interleave, so one buffer is not enough.

<a id="ld-072"></a>

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

<!-- end:ld-072 -->

## Inter-agent messages answer to their own setting.

<a id="ld-073"></a>

- **Inter-agent messages answer to their own setting.** `showAgentMessages` is
  independent of the output mode: what one agent said to another is a different
  question from how much tool detail to show, so Verbose can hide them and Quiet
  can keep them. A completed `finish_subagent` notice remains visible when the
  setting is off because it reports a managed lifecycle result, not conversation.

<!-- end:ld-073 -->

## A written file is a diff of nothing but additions.

<a id="ld-074"></a>

- **A written file is a diff of nothing but additions.** One shape for every
  mutation, so a new file and an edited one read alike. `inlineDiffLines()`
  drops the patch envelope — `*** Begin Patch`, `@@`, `--- a/file` — because
  the row already names the file; only a patch touching several files keeps one
  heading each.

<!-- end:ld-074 -->

## Revealing a row anchors its first line to the top of the viewport.

<a id="ld-075"></a>

- **Revealing a row anchors its first line to the top of the viewport.** Use
  `scrollBy`, never the `scrollTop` setter: only that path marks the scroll as
  manual, and without it sticky-to-bottom pins the row straight back off the
  top of the screen as the revealed content grows beneath it.

<!-- end:ld-075 -->

## Five extra tree-sitter grammars are vendored, not downloaded.

<a id="ld-076"></a>

- **Five extra tree-sitter grammars are vendored, not downloaded.** OpenTUI
  ships JavaScript, TypeScript, Markdown and Zig; `assets/tree-sitter` adds
  Python, JSON, Bash, Rust and Go so a diff highlights offline, in a sandbox,
  and on the first run. `assets/tree-sitter/README.md` records where each file
  came from and why Rust comes from a different build.

<!-- end:ld-076 -->

## Every animation paints through one glow core.

<a id="ld-077"></a>

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

<!-- end:ld-077 -->

## Image markers are atomic input attachments.

<a id="ld-078"></a>

- **Image markers are atomic input attachments.** Alt+V stores clipboard image
  bytes under the system temp directory and inserts `[Image #n]`. Any marker
  edit removes the full marker and file. Sending converts files to pi image
  content, then removes the temporary files.

<!-- end:ld-078 -->

## Completed text selections copy on mouse release.

<a id="ld-079"></a>

- **Completed text selections copy on mouse release.** Local Windows and macOS
  prefer the native clipboard module, then platform commands. Local Linux uses
  display clipboard commands. SSH and Mosh use OpenTUI OSC 52, including its
  detected tmux passthrough framing. Remote OSC 52 output has a bounded payload.

<!-- end:ld-079 -->

## Escape requires confirmation while working.

<a id="ld-085"></a>

- **Escape requires confirmation while working.** The first press shows a hint.
  A second press within two seconds cancels the same selected agent.

<!-- end:ld-085 -->

## `?` on an empty prompt opens the controls

<a id="ld-099"></a>

- **`?` on an empty prompt opens the controls** instead of typing. With any
  text in the line it is an ordinary character. `help-popup.tsx` holds the
  list — keep it in step with the keyboard dispatch in `app.tsx`.

<!-- end:ld-099 -->

## Assistant Markdown renders while streaming.

<a id="ld-100"></a>

- **Assistant Markdown renders while streaming.** OpenTUI's `<markdown>` has a
  streaming mode for unstable trailing blocks. `useMarkdownCaret()` appends a
  stable caret because blinking would reparse and re-highlight the Markdown
  source. Thinking traces remain plain text so shimmer can write a `StyledText`
  directly onto one `<text>` renderable.

<!-- end:ld-100 -->

## `<markdown>` and `<code>` require a `syntaxStyle` and OpenTUI ships no default.

<a id="ld-101"></a>

- **`<markdown>` and `<code>` require a `syntaxStyle` and OpenTUI ships no
  default.** `syntax.ts` builds one from the theme; it is rebuilt whenever the
  theme changes, which is what makes markdown recolour on a theme switch.

<!-- end:ld-101 -->

## Style keys are tree-sitter capture names, and the dotted fallback does not apply on that path.

<a id="ld-102"></a>

- **Style keys are tree-sitter capture names, and the dotted fallback does not
  apply on that path.** Headings are only ever captured as `markup.heading.1`
  through `.6`, so registering `markup.heading` alone leaves them at the
  default colour. Check the shipped queries in
  `@opentui/core/assets/<lang>/highlights.scm` before inventing a key.

<!-- end:ld-102 -->

## Only five tree-sitter parsers ship

<a id="ld-103"></a>

- **The upstream five tree-sitter parsers are not PUM's complete inventory**:
  javascript, typescript, markdown, markdown_inline and zig come from OpenTUI.
  PUM additionally registers the vendored Python, JSON, Bash, Rust and Go grammars
  from `assets/tree-sitter` through `src/syntax-grammars.ts`. Only unsupported
  fences render unhighlighted. The earlier `DownloadUtils` suggestion was a
  historical possibility, not PUM's current path: preserve offline vendoring
  rather than adding runtime downloads.

<!-- end:ld-103 -->

## Interface icons lead their associated text.

<a id="ld-105"></a>

- **Interface icons lead their associated text.** Tool state markers and running
  spinners occupy the existing left gutter, without moving the tool text or its
  details. Settings navigation chevrons precede their values. Keep existing
  leading icons, meaningful syntax, diff signs, carets, scrollbars, and field
  order unchanged.

<!-- end:ld-105 -->

## Glyphs stay plain Unicode.

<a id="ld-106"></a>

- **Glyphs stay plain Unicode.** Dingbats, block, box-drawing, and
  Miscellaneous Symbols only — no Nerd Font. Do not reach for a private-use
  codepoint.

<!-- end:ld-106 -->

## News persists user turns and managed completion responses.

<a id="ld-124"></a>

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

<!-- end:ld-124 -->
