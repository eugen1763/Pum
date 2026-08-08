# PUM

A small coding agent that runs in your terminal.

PUM reads, writes, and edits files and runs shell commands in whatever directory
you start it from. It is built on [pi](https://github.com/earendil-works/pi) for
the agent loop and [OpenTUI](https://github.com/anomalyco/opentui) for the
interface. The whole thing is about 400 lines.

## Requirements

[Bun](https://bun.sh). OpenTUI's renderer needs it.

## Install

```bash
git clone https://github.com/eugen1763/Pum
cd Pum
bun install
```

## Log in

PUM keeps its own credentials, separate from pi's. This opens pi's login flow
pointed at PUM's config directory:

```bash
bun run login
```

Run `/login` inside it, pick a provider, then quit. Works with a Claude or
ChatGPT subscription, an API key, or any of the providers pi supports.

## Use it

```bash
bun run start
```

| Key | Effect |
|---|---|
| Enter | Send |
| Esc | Cancel the running turn |
| Ctrl+P | Settings — theme, animations, thinking level, thinking traces, model |
| Ctrl+C | Once warns, twice quits |

A top bar carries the model, thinking level, git branch, token count, cost, and
how much of the context window is gone. While the agent works it grows a
spinner, a timer, and a colour sweep through the label.

## Theming

Three presets ship — `tokyonight`, `gruvbox`, `catppuccin` — switchable from
Ctrl+P. To change individual colours, drop a `theme.json` in the config
directory; it overrides whichever preset is active, and you only need the
tokens you care about:

```json
{ "accent": "#ff7a93", "userBg": "#2a2f45" }
```

The agent has four tools: `read`, `write`, `edit`, and `bash`. **It runs all of
them without asking.** Start it somewhere you are happy for it to make changes.

## Where things live

Everything sits under `~/.config/pum` — set `PUM_DIR` to move it.

| | |
|---|---|
| `auth.json` | Credentials |
| `settings.json` | Model and thinking level, saved as you change them |
| `pum.json` | Theme, animations, whether to show thinking traces |
| `theme.json` | Optional colour overrides |
| `sessions/` | Conversation history, one file per session |

## Hacking on it

See [AGENTS.md](AGENTS.md) for the layout, the decisions behind it, and the
handful of OpenTUI and pi behaviours worth knowing before you change anything.

## License

[MIT](LICENSE).
