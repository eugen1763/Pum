# PUM vs pi benchmark

This harness compares PUM and pi on identical coding exercises. It uses the
**Aider polyglot** exercise set (`Aider-AI/polyglot-benchmark`), which is based
on the Exercism tracks.

Aider's own harness does not work here. `benchmark.py` drives Aider's loop. This
harness extracts each exercise and drives `pi -ne` and `pum -p` directly, so both
agents get the same prompt and the same files.

## Prerequisite

- `pi` must be configured and logged in for the `ds4-ops` model.
- `pum` must be configured and logged in (PUM keeps its own config).
- The model provider must accept calls. This benchmark uses real model tokens.

Both agents share the same agent loop. The measurable differences are PUM's Bash
output summarization, Check mode latency, and context cost.

## How to run

From the repo root:

```bash
bun run research/bench-pi-vs-pum/harness.ts --track all --limit 10
```

The first run clones the exercise repo into `.work/`. A small `--limit` gives a
fast sanity check. Use a larger limit for meaningful results.

Run one exercise:

```bash
bun run research/bench-pi-vs-pum/harness.ts --track js --problem affine-cipher
```

Validate the setup without spending model tokens:

```bash
bun run research/bench-pi-vs-pum/harness.ts --dry
```

## Options

| Option | Effect |
|---|---|
| `--track <js,go,python,cpp,java,rust\|all>` | Which tracks to run. |
| `--limit <n>` | Max exercises per track (default 10). |
| `--problem <name>` | Run one exercise by name. |
| `--agents <pi,pum>` | Which agents to run (default both). |
| `--work <dir>` | Scratch dir for the cloned repo and runs. |
| `--timeout <sec>` | Per-agent timeout (default 300). |
| `--pi-cmd <cmd>` / `--pum-cmd <cmd>` | Override agent commands. |
| `--dry` | Check plumbing without invoking the model. |
| `--no-tokens` | Disable token capture. |

## What each run measures

For each exercise and each agent:

- **Pass/fail**: runs the exercise test suite after the agent finishes. PUM
  enables skipped tests (`xtest`/`xit`, `@Disabled`, `#[ignore]`) so the full
  suite is graded.
- **Wall seconds**: the agent run time.
- **Tokens**: best-effort sum of usage read from each agent's session files.
  `pum` reads `$PUM_DIR/sessions`, `pi` reads `~/.pi/agent/sessions`. If the
  files cannot be found, tokens is `n/a`.

Results are written to `.work/results.json` and a summary table is printed.

## Track support and toolchains

| Track | Toolchain | Notes |
|---|---|---|
| `js` | `node`, `npm`, `npx` | Per-exercise `npm install`, then jest. |
| `go` | `go` | `go test ./...`. |
| `python` | `uv` | `uv run --with pytest python -m pytest`. |
| `cpp` | `g++`, `cmake` | Best effort; CMake + Catch2. |
| `java` | `java`, `javac` | `./gradlew test` or `mvn test`. |
| `rust` | `cargo` | `cargo test`. |

A track is skipped when its toolchain is absent. On the machine where this was
built, only `js` and `go` are runnable out of the box; `python` becomes
runnable once `uv` can download a Python (no PATH change needed).

## Caveats

- Jet speed and cost scale with `--limit` and the number of tracks.
- The Java and C++ test runners are best-effort and may need real project
  harnesses to be faithful.
- Token capture is approximate and depends on session-file location.
- The exercise repo is cloned at first run and reused afterward.

## Benchmark results (2026-08-13)

Raw data:
- Check mode on: `results-2026-08-13.json`
- Check mode off: `results-2026-08-13-checkoff.json`

Both agents used `ds4-ops`. Baseline is `pi -ne`. PUM is the released
`pum 0.2.13-beta.1` (`PUM_CMD=pum`). Run: `--track all --limit 10`.

Values are the mean over non-skipped exercises per track (10 per track).

### Pass / fail

| Track | pi | pum |
|---|---|---|
| js | 10/10 | 10/10 |
| go | 9/10 | 9/10 |
| python (check on) | 9/10 | 10/10 |
| python (check off) | 8/10 | 10/10 |
| cpp, java, rust | skipped (no toolchain) | skipped |

### Time and tokens, Check mode on

| Track | pi s | pi tok | pum s | pum tok |
|---|---|---|---|---|
| js | 35.4 | 142 164 | 54.4 | 386 354 |
| go | 24.2 | 131 198 | 79.3 | 588 699 |
| python | 68.4 | 210 996 | 32.9 | 350 597 |

### Time and tokens, Check mode off

| Track | pi s | pi tok | pum s | pum tok |
|---|---|---|---|---|
| js | 34.5 | 197 384 | 41.4 | 215 952 |
| go | 17.8 | 121 031 | 33.0 | 169 022 |
| python | 150.3 | 152 157 | 62.3 | 218 497 |

### Combined view

| Track | Agent | Check on (s / tok) | Check off (s / tok) |
|---|---|---|---|
| js | pi | 35.4 / 142 164 | 34.5 / 197 384 |
| js | pum | 54.4 / 386 354 | 41.4 / 215 952 |
| go | pi | 24.2 / 131 198 | 17.8 / 121 031 |
| go | pum | 79.3 / 588 699 | 33.0 / 169 022 |
| python | pi | 68.4 / 210 996 | 150.3 / 152 157 |
| python | pum | 32.9 / 350 597 | 62.3 / 218 497 |

### Key notes

- Both agents solved almost every runnable exercise. The real deltas favor PUM
  on Python: it passed 10/10 in both runs, while pi passed 9/10 (check on) and
  8/10 with four 300s timeouts (check off).
- Go `counter` failed for both agents: the exercise needs a `COUNTER_IMPL`
  build tag/env that the harness did not set. It is a setup gap, not a model
  result.
- The two to four times higher PUM token count with Check mode on is from the
  verifier: every checked Bash/edit triggers a verifier model call. With Check
  mode off, PUM tokens drop to near pi's level (go/pum 589k -> 169k, js/pum
  386k -> 216k) and PUM runs faster. Remaining difference is PUM's larger
  system prompt, not the Bash-output summarizer.
