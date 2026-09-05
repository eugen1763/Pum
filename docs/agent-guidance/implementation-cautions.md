# Implementation cautions and historical debugging evidence

The prescriptions in this document remain **current mandatory implementation constraints**. The past incidents, timings and dependency-version anecdotes explain why; they are historical evidence, not present-day benchmark, compatibility or enforcement claims. Revalidate dependency-specific observations against the installed source before an upgrade. Do not discard the associated safeguards because an anecdote is old. Read the applicable cautions before UI, session, filesystem, Windows or sandbox work. See [current security contracts](security.md), [TUI contracts](tui.md) and the [topic index](README.md).

<a id="bites-preamble"></a>

## Things that bite

Each of these cost real debugging. They are not obvious from the docs.

<!-- end:bites-preamble -->

## `useKeyboard` sees keys before the focused `<textarea>`

<a id="bite-001"></a>

- **`useKeyboard` sees keys before the focused `<textarea>`**, and
  `key.stopPropagation()` keeps them from reaching it. Escape and Ctrl+P are
  unbound in the textarea, so they are safe as global shortcuts. All shortcuts
  live in the one handler in `app.tsx`.

<!-- end:bite-001 -->

## Raw Ctrl+H and Backspace can both be `^H`.

<a id="bite-002"></a>

- **Raw Ctrl+H and Backspace can both be `^H`.** OpenTUI reports that byte as
  plain Backspace. PUM keeps Backspace behavior for the ambiguous byte. Use
  `/history` or its alias `/resume` when the terminal does not report Ctrl+H distinctly.

<!-- end:bite-002 -->

## Two fast Ctrl+C presses arrive in one React batch

<a id="bite-003"></a>

- **Two fast Ctrl+C presses arrive in one React batch**, so state read inside the
  handler is still stale on the second. The quit check compares timestamps held
  in a ref. Any keyboard rule that depends on "did this just happen" needs the
  same treatment.

<!-- end:bite-003 -->

## Finish on `agent_settled`, not `agent_end`.

<a id="bite-004"></a>

- **Finish on `agent_settled`, not `agent_end`.** `agent_end` fires before an
  automatic retry, so clearing the busy flag there unlocks the input mid-run.

<!-- end:bite-004 -->

## OpenTUI has no modal and no checkbox.

<a id="bite-005"></a>

- **OpenTUI has no modal and no checkbox.** The popup is a `<box>` with
  `position: "absolute"` and a `zIndex`. Stacking only orders siblings, so it
  must be a direct child of the root box. Give it a background colour — an
  absolute box does not paint over what is under it.

<!-- end:bite-005 -->

## `focused` is applied on change, not declared.

<a id="bite-006"></a>

- **`focused` is applied on change, not declared.** Drive it from a single
  expression per element (`focused={!settingsOpen}`), or focus vanishes when a
  popup unmounts and never comes back.

<!-- end:bite-006 -->

## The popup's main page has no focusable children.

<a id="bite-007"></a>

- **The popup's main page has no focusable children.** Rows are plain `<text>`
  and the cursor is state. That avoids the missing-checkbox problem and the
  focus juggling at once. Model pages use one `<input>` and one `<select>` with
  a single explicit focus owner.

<!-- end:bite-007 -->

## `<textarea onSubmit>` receives no text value.

<a id="bite-008"></a>

- **`<textarea onSubmit>` receives no text value.** Read `plainText` from the
  textarea ref instead.

<!-- end:bite-008 -->

## A `<text>` whose `content` is a `StyledText` measures to nothing.

<a id="bite-009"></a>

- **A `<text>` whose `content` is a `StyledText` measures to nothing.** It
  renders as a zero-height row unless you give it a size — `flexGrow: 1`, or an
  explicit `height` on its parent. This silently swallowed the whole status bar.

<!-- end:bite-009 -->

## A whitespace-only `<text>` is not a reliable spacer.

<a id="bite-010"></a>

- **A whitespace-only `<text>` is not a reliable spacer.** Used as a gutter it
  measured one column narrower once the neighbouring text wrapped, so indents
  drifted between wrapped and unwrapped rows. Use a `<box>` with a *numeric*
  `width` — numeric sizes also set `flexShrink: 0`, string ones do not.

<!-- end:bite-010 -->

## Never pass `content={undefined}` to an OpenTUI `<text>` from React.

<a id="bite-011"></a>

- **Never pass `content={undefined}` to an OpenTUI `<text>` from React.**
  OpenTUI 0.5.1 crashes in `setStyledText` (`text.chunks`) when a retained
  renderable's `content` changes from text to `undefined`. The working-caret
  rows hit this when a slash command set the busy state beneath an existing
  last row. Keep the value defined (an empty string works) and let the caret
  hook paint over it after React commits.

<!-- end:bite-011 -->

## Auto-sized boxes shrink.

<a id="bite-012"></a>

- **Auto-sized boxes shrink.** Anything that must keep its height needs
  `flexShrink: 0`, or a taller sibling steals its rows and overdraws it.

<!-- end:bite-012 -->

## The scrollbar auto-shows and re-wraps everything.

<a id="bite-013"></a>

- **The scrollbar auto-shows and re-wraps everything.** Once the transcript
  passes one screen it appears, costs a column, and every message re-flows.
  `verticalScrollbarOptions={{ visible: true }}` pins it.

<!-- end:bite-013 -->

## `FooterDataProvider` is not exported.

<a id="bite-014"></a>

- **`FooterDataProvider` is not exported.** Only the `ReadonlyFooterDataProvider`
  *type* is, and the package's exports map blocks deep imports — hence
  `git-branch.ts`.

<!-- end:bite-014 -->

## `SessionManager` ignores `agentDir`.

<a id="bite-015"></a>

- **`SessionManager` ignores `agentDir`.** Given no explicit directory it writes
  to `~/.pi/agent/sessions/`, so PUM silently scattered its conversations
  through pi's own store. Always pass `sessionDir(cwd)` from `config.ts`, to
  both `create()` and `continueRecent()`, or resume looks in the wrong place.

<!-- end:bite-015 -->

## Keyboard handlers must read state from refs, not closures.

<a id="bite-016"></a>

- **Keyboard handlers must read state from refs, not closures.** A keypress can
  arrive before React has re-rendered, so the handler still sees the previous
  value. This bit twice: the double Ctrl+C, and Esc-to-cancel silently doing
  nothing right after a submit. `busyRef` mirrors `busy` for this reason.
  Escape confirmation also uses timestamp and selected-agent refs. Reset these
  refs when the timer expires, the selected transcript changes, or work settles.

<!-- end:bite-016 -->

## Do not use `useTimeline`.

<a id="bite-017"></a>

- **Do not use `useTimeline`.** It builds a new `Timeline` every render but only
  registers the first, so it stops updating after one re-render. Animation here
  runs off a single `renderer.setFrameCallback` instead, writing `content`
  straight onto renderables so React never re-renders per frame. The clock
  holds `requestLive()` only while something animates, so idle costs nothing.

<!-- end:bite-017 -->

## A context value built inline re-renders the whole transcript.

<a id="bite-018"></a>

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

<!-- end:bite-018 -->

## OpenTUI paints only the viewport but lays out every mounted row.

<a id="bite-019"></a>

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

<!-- end:bite-019 -->

## Windows path spelling is not identity.

<a id="bite-020"></a>

- **Windows path spelling is not identity.** A single directory can appear as a
  long path, an 8.3 short path, or with different case. Additional Check mode
  roots and mutation targets must use the shared canonical identity and
  containment helpers in `platform.ts`; raw string or `realpath()` spelling
  comparisons can reject valid roots or authorize the wrong boundary.

<!-- end:bite-020 -->

## `realpathSync` and `realpath` disagree about 8.3 names.

<a id="bite-021"></a>

- **`realpathSync` and `realpath` disagree about 8.3 names.** The sync one
  leaves a short name as it found it; the async one expands it. A root
  registered through one then never matches a path resolved through the other,
  and only Windows sees it, because only Windows has short names. Go through
  `canonicalRealpathSync` / `canonicalRealpath` in `platform.ts`, which ask the
  OS. This previously affected staged pasted text, and it also affected captured
  bash output handed to the agent under a spelling PUM's own sandbox refused.

<!-- end:bite-021 -->

## Windows strips a trailing space from a path component.

<a id="bite-022"></a>

- **Windows strips a trailing space from a path component.** `repo dir ` is
  created as `repo dir`, so a case built on one cannot be reproduced there.

<!-- end:bite-022 -->

## A contended exclusive create is `EPERM` on Windows, not `EEXIST`

<a id="bite-023"></a>

- **A contended exclusive create is `EPERM` on Windows, not `EEXIST`** - the
  same code a filesystem uses to say it cannot lock at all. Telling the two
  apart by whether the lock file exists is not enough on its own: a holder
  releasing between the failed create and the check looks identical. Only a
  failure that repeats means locking is unavailable.

<!-- end:bite-023 -->

## An atomic rename can fail briefly on Windows.

<a id="bite-024"></a>

- **An atomic rename can fail briefly on Windows.** Antivirus and file indexing
  can return `EPERM`, `EACCES`, or `EBUSY` while a cache file is replaced. Retry
  only these codes for a bounded period, including during rollback.

<!-- end:bite-024 -->

## Bubblewrap mount order is part of the security policy.

<a id="bite-025"></a>

- **Bubblewrap mount order is part of the security policy.** Add system and
  read-only mounts first, writable project roots next, and private temporary and
  denied-path masks last. Reordering these arguments can expose credentials
  through a broader earlier bind.

<!-- end:bite-025 -->

## MXC availability requires the native BaseContainer tier.

<a id="bite-026"></a>

- **MXC availability requires the native BaseContainer tier.** Importing the
  optional SDK or receiving its AppContainer+DACL tier does not mean enforcement
  is available. Auto must warn and fall back; Require must block. Never accept
  the DACL tier because it can persist host ACL changes.

<!-- end:bite-026 -->

## MXC imports must select native Windows tools before module evaluation.

<a id="bite-027"></a>

- **MXC imports must select native Windows tools before module evaluation.** MXC
  0.7 runs `whoami /user` while loading. Bun can cache the child-process
  environment before a PATH guard applies, so PUM loads the SDK while the current
  directory is Windows `System32`, then restores the authoritative directory.

<!-- end:bite-027 -->
