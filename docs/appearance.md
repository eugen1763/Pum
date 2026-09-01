# Appearance

[← Back to the README](../README.md)

## Transcript detail

**Transcript detail** in `Ctrl+P` decides how much of a tool call the transcript
shows. It changes presentation only — nothing is rewritten in the session or in
the model's context, so switching modes re-renders everything you already have.

- **Quiet** folds every successful call into one activity row, commands and mutations included.
- **Normal** keeps commands and mutations as their own rows, and shows an editing tool's diff inline without being asked, capped at twenty changed lines.
- **Verbose** lists every call, expanded, with the complete retained input and result and no rendered diff.

Opening a single row works in any mode. Outside Verbose it shows the result's
last twenty lines with a count of what was hidden — no JSON envelope, and no
echo of arguments the row above already spells out, so an opened group of reads
is just the files with their offsets. Verbose stays the raw view, and copying a
row always copies everything retained.

Two rules keep the transcript still enough to read. A tool call that starts and
finishes within 400ms is never drawn in its running form — it appears already
settled — and any row that was drawn keeps that form for two seconds whatever
happens underneath. Live command output opens after half a second of running and
closes two seconds later, once, however often you switch between agents.

**Agent messages** is a separate toggle: what one agent said to another is a
different question from how much tool detail you want, so Verbose can hide them
and Quiet can keep them. A subagent completion notice always remains visible.

## Themes

PUM includes `tokyonight`, `gruvbox`, `catppuccin`, `nord`, `dracula`,
`rosepine`, `solarized`, `kanagawa`, and `github-light`. Select a preset in
`Ctrl+P`.

Create `theme.json` in the PUM config directory to override semantic tokens:

```json
{
  "accent": "#ff7a93",
  "userBg": "#2a2f45"
}
```

Colour means one thing each: red is errors and removed lines, green success and
added lines, orange blocked, and nothing else wears a signal colour.

## Markdown and code

Markdown renders while it streams. OpenTUI ships parsers for JavaScript,
TypeScript, Zig, and Markdown, and PUM vendors five more under `assets/` —
Python, JSON, Bash, Rust, and Go — so a diff highlights offline and on the first
run. Other fenced languages still render as code blocks, without colour.

## Animation

**Working animation** in `Ctrl+P` chooses how the rules above and below the
transcript move while an agent works: `off`, `input-only`, `coordinated`,
`comet-pair`, `electric-spark`, `constellation`, `random-constellation`, or
`energy-transfer`. PUM disables motion when true colour is unavailable.

**The prompt placeholder** says what the agent does while it works:
`Working... (send to steer)` while a tool runs, and
`Forming a thought... (send to steer)` while the model composes an answer. A
bright crest crosses the phrase once every few seconds, and the letter at the
top of the crest is raised while it passes. A letter with no raised form, such
as the `F` of `Forming`, brightens without moving. The steer note never moves.
`Animations off` returns the placeholder to plain dim text.

## Terminal title

PUM sets a compact title such as `Pum · working · 2 subagents`, counting only
starting or running subagents, and clears it during graceful shutdown.

Windows Terminal and common Linux terminal emulators accept the title through
OpenTUI. Inside `tmux`, PUM sets the active pane title; to copy that to the
outer terminal title:

```tmux
set -g set-titles on
set -g set-titles-string '#T'
```

Keep `allow-set-title` enabled so applications can update the pane title. A
`tmux` configuration can replace or suppress application titles, and PUM cannot
override that server policy.
