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
| `src/app.tsx` | The TUI — transcript, input, keyboard dispatch, agent events |
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

## Testing a TUI

Neither the UI nor the agent loop can be checked by typechecking alone.

- Drive the real UI through a pty: pipe keystrokes into
  `script -qec "bun run src/index.tsx" /dev/null` and read the frames back with
  the escape codes stripped. OpenTUI redraws only what changed, so expect
  fragments, not whole screens.
- To exercise streaming, thinking traces, and cancelling, point a throwaway
  `PUM_DIR` at a local OpenAI-compatible mock server through `models.json`
  (`api: "openai-completions"`, `compat.thinkingFormat: "deepseek"`, an inline
  `apiKey`). Have it stream reasoning deltas and then content slowly enough to
  interrupt. This keeps tests off the real config and off a paid model.
