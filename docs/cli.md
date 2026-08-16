# Command line

[← Back to the README](../README.md)

```text
pum [options]
pum login [options]
pum -p "<text>" [options]
pum worktree [login] [options] [directory]
pum s [login] [options] [directory[:ro|:rw] ...]
pum sr [login] [options] [directory[:ro|:rw] ...]
pum ss
```

| Option or command | Action |
|---|---|
| `-h`, `--help` | Print the command-line manual and exit |
| `-v`, `--version` | Print the exact `pum-agent` package version and exit |
| `-r`, `--resume` | Resume the latest session for the current directory |
| `-p`, `--prompt <text>` | Run one prompt without the TUI, print the answer, and exit |
| `--statsFile <path>` | Write a JSON statistics artifact after a headless run |
| `--override` | Let `--statsFile` replace an existing file |
| `--` | End the options; later arguments are directories |
| `login` | Start PUM with the provider login panel open |
| `worktree`, `w` | Create a worktree under `.pum/worktrees` and start a session in it |
| `s` | Start PUM in a writable outer `claudebox` sandbox |
| `sr` | Start PUM with the current directory read-only |
| `ss` | Check the `claudebox` runtime and protocol version |

Help, version, and sandbox setup checks do not initialize the TUI, credentials,
or sessions. Help and version print even when a later argument is invalid. Other
unknown options and commands return an error and a help hint.

## Directories

Plain extra directories use the command default. Add `:ro` or `:rw` to select
explicit access. `pum sr` always keeps the launch directory read-only, but it
permits an explicit writable extra directory. A custom `PUM_DIR` must remain
outside the project for `pum sr`.

Write `login` before the directories. PUM rejects a later `login` instead of
mounting it. Put `--` before a directory whose name starts with a dash or is
called `login`.

## Headless runs

`pum -p "<text>"` runs one prompt with `read`, `write`, `edit`, `apply_patch`,
and `bash`, and nothing else: the interactive tools need a running TUI. It keeps
the configured Check mode, sandbox, writing style, and explanation strength, and
the session persists to the normal per-directory store, so `-r` and the TUI can
continue it.

Add `--statsFile <path>` for a versioned JSON artifact with run metadata and all
`/stats` data. PUM creates missing parent directories and rejects an existing
file before startup unless `--override` is present. `--stats-file` also works.

## Environment

| Variable | Effect |
|---|---|
| `PUM_DIR` | Override PUM's complete configuration and data directory |
| `PUM_CLAUDEBOX` | Select a specific `claudebox` executable |

See [Configuration and data](configuration.md) for what PUM stores and where.
