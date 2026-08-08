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
| `src/tool-line.ts` | Which argument to show, and `+n −n` from an edit patch |
| `src/git-branch.ts` | Reads and watches `.git/HEAD` |
| `src/history.ts` | Prompt history, one list per working directory |
| `src/replay.ts` | Rebuilds transcript lines from a resumed session's messages |
| `src/settings-popup.tsx` | The Ctrl+P panel. Presentational; owns no keyboard logic |
| `src/settings.ts` | PUM's own `pum.json` |
| `src/config.ts` | Where the config dir lives |

## Keys

| Key | Effect |
|---|---|
| Enter | Send the prompt |
| Esc | Cancel the running turn |
| Ctrl+P | Open settings; Esc closes, or steps back from the model list |
| Ctrl+C | Once arms and shows a hint, twice within 2s quits |

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
- **All four tools run without asking.** No approval prompt.
- **Sessions persist** to `<config dir>/sessions`.
- **Colours are never literals.** Everything reads a semantic token from
  `theme.ts`. Three presets ship; `theme.json` in the config dir overrides any
  subset of tokens. Add a token rather than a hex code.
- **Compact by default.** No borders around the input, no blank rows between
  turns, no padding that does not earn its place. A user turn is a full-width
  background bar; everything after it indents two columns.
- **Animation is on by default** and turns itself off without true colour.
- **Model and thinking level are pi's to persist.** `setModel()` and
  `setThinkingLevel()` write to `<config dir>/settings.json`, and
  `createAgentSession` reads them back at startup. Do not duplicate that here.
  `pum.json` holds only what pi does not know about — currently `showThinking`.

## Things that bite

Each of these cost real debugging. They are not obvious from the docs.

- **`useKeyboard` sees keys before the focused `<input>`**, and
  `key.stopPropagation()` keeps them from reaching it. Escape and Ctrl+P are
  unbound in the input, so they are safe as global shortcuts. All shortcuts live
  in the one handler in `app.tsx`.
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
  focus juggling at once. Only the model list is a real focusable `<select>`.
- **`<input onSubmit>` is typed as taking an empty `SubmitEvent`** though it
  passes a string at runtime. Read the value off the ref instead.
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
