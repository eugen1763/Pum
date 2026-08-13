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

## Results (2026-08-13, --track all --limit 10)

Raw JSON: `results-2026-08-13.json`. Both agents used `ds4-ops`; `pi -ne` vs released `pum 0.2.13-beta.1` (`PUM_CMD=pum`).

### Pass/fail per track (per agent)

| Track | pi | pum |
|---|---|---|
| js | 10/10 | 10/10 |
| go | 9/10 | 9/10 |
| python | 9/10 | 10/10 |
| cpp | skipped (no g++) | skipped |
| java | skipped (no JDK) | skipped |
| rust | skipped (no cargo) | skipped |

Notes:
- Go `counter` failed identically for both agents: the exercise needs a `COUNTER_IMPL` build tag/env that the harness did not set. It is a setup gap, not a model result.
- Python `beer-song`: `pi` failed (3 tests), `pum` passed.
- Python `dominoes`: `pi` hit the 300s agent timeout but its saved work passed the test; `pum` finished normally (`pass: true`, `seconds: 300.03`, `exitCode: null` for pi).

### Mean wall time and tokens (per non-skipped run)

| Track/agent | avg seconds | avg tokens |
|---|---|---|
| js/pi | 35.4 | 142 164 |
| js/pum | 54.4 | 386 354 |
| go/pi | 24.2 | 131 198 |
| go/pum | 79.3 | 588 699 |
| python/pi | 68.4 | 210 996 |
| python/pum | 32.9 | 350 597 |

Interpretation:
- Both agents solved almost every runnable exercise. The two real deltas favor PUM on Python (`beer-song`, `dominoes`) and favor pi on speed in most tracks.
- PUM reports 2-4x more tokens than pi. Do not read this as a Bash-summarization failure. The released `pum` runs its configured Check mode (on), which adds verifier model calls on every checked Bash/edit, plus a larger system prompt. To isolate the Bash-output feature, run PUM with Check mode off and compare only then.

## Results (2026-08-13, Check mode off) — `results-2026-08-13-checkoff.json`

PUM was re-run with `checkMode: off` (and `sandboxMode: off`) in `pum.json` so the only meaningful difference from `pi -ne` is PUM's Bash-output summarization and system prompt.

### Mean wall time and tokens (per non-skipped run)

| Track/agent | avg seconds | avg tokens |
|---|---|---|
| js/pi | 34.5 | 197 384 |
| js/pum | 41.4 | 215 952 |
| go/pi | 17.8 | 121 031 |
| go/pum | 33.0 | 169 022 |
| python/pi | 150.3 | 152 157 |
| python/pum | 62.3 | 218 497 |

Pass/fail per track (per agent):

| Track | pi | pum |
|---|---|---|
| js | 10/10 | 10/10 |
| go | 9/10 | 9/10 (same `counter` env gap) |
| python | 8/10 | 10/10 |

### Effect of turning Check mode off on PUM

| Track | pum tokens (check on) | pum tokens (check off) | pum sec (on -> off) |
|---|---|---|---|
| js | 386 354 | 215 952 | 54.4 -> 41.4 |
| go | 588 699 | 169 022 | 79.3 -> 33.0 |
| python | 350 597 | 218 497 | 32.9 -> 62.3 |

With Check mode off, PUM's token usage is close to pi's (it still carries a larger system prompt). The verifier was the dominant extra cost. On Python, PUM passed all 10 exercises while pi passed 8 and timed out (300s) on 4 runs.
