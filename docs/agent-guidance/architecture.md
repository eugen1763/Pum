# Runtime, startup and provider contracts

Current mandatory implementation guidance. Read before changing startup, CLI, providers, login or dependencies. See the [topic index](README.md).

<a id="intro"></a>

# PUM

A small coding agent with a terminal UI. It wraps pi's agent loop in an OpenTUI
front end and keeps its own credentials and settings.

```
bun run login    # log in through pi, pointed at PUM's own config dir
bun run start    # open the TUI in the current directory
```

<!-- end:intro -->

## Bun

<a id="ld-001"></a>

- **Bun** as the runtime. OpenTUI's renderer needs it.

<!-- end:ld-001 -->

## CLI help and version exit before startup.

<a id="ld-002"></a>

- **CLI help and version exit before startup.** `src/index.tsx` reads package metadata, parses arguments, and dynamically imports `src/main.tsx` only for direct TUI startup (or `src/headless.ts` for `-p`). Unknown options and commands exit with code 2, but `-h`/`--help` and `-v`/`--version` print and exit 0 even when a later argument is invalid. `--` ends option parsing, so an operand may start with `-`. In `pum s`/`pum sr` the `login` keyword must come before any mount directory, so a directory genuinely named `login` stays mountable after `--`. Startup accepts `login`, `-r`/`--resume`, and `-p`/`--prompt <text>`. `pum s` and `pum sr` launch the TUI through the outer sandbox. `pum ss` probes the runtime without starting the TUI.

<!-- end:ld-002 -->

## `-p` is headless.

<a id="ld-003"></a>

- **`-p` is headless.** `pum -p "<text>"` runs one prompt in `src/headless.ts` with read, write, edit, bash, memory_read, memory_edit, history, get_context_remaining, and new_context. It keeps the configured Check mode (on/off), sandbox, writing style, and explanation strength. Interactive tools (questionnaire, enable_tools, subagents, triggers, message cache) are not registered. The session persists to the normal per-directory store, so `-r` and the TUI can continue it. Headless mode does not combine with `pum s` or `pum sr` in the current launcher protocol.

<!-- end:ld-003 -->

## `@earendil-works/pi-coding-agent`

<a id="ld-004"></a>

- **`@earendil-works/pi-coding-agent`**, not `pi-ai` on its own. It brings the
  agent loop, session files, and the `read`/`write`/`edit`/`bash` tools. Using
  `pi-ai` alone would mean writing all of that here.

<!-- end:ld-004 -->

## There is no custom patch model tool.

<a id="ld-005"></a>

- **There is no custom patch model tool.** Use pi's `edit` tool for targeted
  file mutations. Do not register or advertise `apply_patch` as a session tool.

<!-- end:ld-005 -->

## OpenTUI with React

<a id="ld-006"></a>

- **OpenTUI with React** for the UI.

<!-- end:ld-006 -->

## Model fallbacks are process-local and additive.

<a id="ld-007"></a>

- **Model fallbacks are process-local and additive.** TUI and headless startup
  install the GPT-6 Astra fallback for OpenAI and Codex before selecting models.
  Provider authentication and transport remain pi's; an existing upstream entry
  always wins. Nothing writes these fallbacks to user configuration. The Codex
  fallback keeps pi's conservative 272K context budget. The model and Check model
  pickers refresh on `r` only outside their search field, with one refresh in
  flight. Static provider catalogs cannot discover missing entries by refresh.

<!-- end:ld-007 -->

## pi 0.85.0 needs an explicit server dependency.

<a id="ld-008"></a>

- **pi 0.85.0 needs an explicit server dependency.** Its SDK imports
  `@earendil-works/pi-server` without declaring it. Keep the matching dependency
  until upstream fixes its package manifest.

<!-- end:ld-008 -->

## PUM keeps its own config dir

<a id="ld-009"></a>

- **PUM keeps its own config dir**, with platform-specific defaults and a
  `PUM_DIR` override. Linux normally uses `~/.config/pum` (or `$XDG_CONFIG_HOME/pum`);
  macOS and Windows defaults are listed in [configuration](../configuration.md).
  It does not share pi's `~/.pi/agent`, so it needs its own login. pi stores
  auth, settings, and sessions together under one directory, so this is all or
  nothing.

<!-- end:ld-009 -->

## Login runs inside PUM.

<a id="ld-011"></a>

- **Login runs inside PUM.** Startup without an available provider opens the
  login popup. `/login` opens the same popup. The provider list comes from
  `ModelRuntime.getProviders()` and must not be replaced with a local allowlist.

<!-- end:ld-011 -->

## Custom provider discovery is conservative.

<a id="ld-015"></a>

- **Custom provider discovery is conservative.** PUM normalizes an HTTP(S)
  endpoint and probes only the OpenAI-compatible `/models` route. PUM does not
  infer a different API shape from a failed probe. Config writes use a temporary
  file and atomic rename.

<!-- end:ld-015 -->
