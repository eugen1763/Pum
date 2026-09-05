# TUI test workflow

Current mandatory test guidance. The failures described below are historical evidence for these precautions, not a fresh validation run. See the [topic index](README.md).

<a id="testing"></a>

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

<!-- end:testing -->
