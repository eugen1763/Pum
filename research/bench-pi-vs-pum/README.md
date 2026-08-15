# PUM vs pi vs OpenCode benchmark

This harness compares PUM, pi, and OpenCode on identical coding exercises. It
uses the **Aider polyglot** exercise set (`Aider-AI/polyglot-benchmark`), which
is based on the Exercism tracks.

Aider's own harness does not work here. `benchmark.py` drives Aider's loop. This
harness extracts each exercise and drives `pi -ne`, `pum -p`, and
`opencode run` directly, so all three agents get the same prompt and the same
files.

## Prerequisite

- `pi` must be configured and logged in for the same model PUM uses.
- `pum` must be configured and logged in (PUM keeps its own config).
- `opencode` must be configured for the same model (`litellm/ds4-ops` by
  default). The model provider must accept calls. This benchmark uses real
  model tokens.

All three agents drive the same underlying model, so the measurable differences
are PUM's Bash output summarization, Check mode latency, context cost, and the
number of tool round-trips each harness spends per task.

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
| `--agents <pi,pum,opencode>` | Which agents to run (default pi,pum). |
| `--work <dir>` | Scratch dir for the cloned repo and runs. |
| `--timeout <sec>` | Per-agent timeout (default 300). |
| `--pi-cmd <cmd>` / `--pum-cmd <cmd>` / `--opencode-cmd <cmd>` | Override agent commands. |
| `--dry` | Check plumbing without invoking the model. |
| `--no-tokens` | Disable token capture. |

## What each run measures

For each exercise and each agent:

- **Pass/fail**: runs the exercise test suite after the agent finishes. PUM
  enables skipped tests (`xtest`/`xit`, `@Disabled`, `#[ignore]`) so the full
  suite is graded.
- **Wall seconds**: the agent run time.
- **Tokens**: best-effort usage sum. `pum` reads `$PUM_DIR/sessions`, `pi` reads
  `~/.pi/agent/sessions`. `opencode` reads its per-session token counters from
  its SQLite store. Token accounting is not directly comparable across agents:
  OpenCode records `cache_read` far larger than the others, so treat tokens as
  approximate and lean on pass/fail and wall seconds for the headline result.

Results are written to `.work/results.json` and a summary table is printed.

## OpenCode specifics

OpenCode resolves its working directory to the enclosing git worktree root, not
the process `cwd`. The harness therefore runs each OpenCode exercise in its own
fresh git repository under `.work/runs/` and passes `--dir <runDir>`, so every
exercise stays isolated from the benchmark repo. Without this, OpenCode anchors
to the benchmark repo root, never touches the exercise files, and fails every
exercise — a harness artifact, not a model result.

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
- Token capture is approximate and the three agents count differently (see
  above).
- The exercise repo is cloned at first run and reused afterward.
- Each exercise is one run per agent. The same model is fuzzy, so a small run
  can flip a single exercise; `--limit` larger gives a steadier pass rate.

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
- The two to four times higher PUM token count in the Check-mode-on columns is
  the advisory verifier: every sensitive Bash/edit reached a verifier model
  call. Current code does not do that per call — `prepareCheck` returns a
  balanced-allow fast path for ordinary complete project-local Bash and edits,
  so the verifier only runs for config/executable-sensitive mutations. A fresh
  On-mode run should land near the Check-off numbers.
- PUM's system prompt is **not** oversized, and it is now smaller than pi's.
  Measured with the full headless extension set (writing style STE, Check off),
  PUM's is 9 165 vs pi's 9 192 chars; with the default STE-off install it is
  well below pi because PUM *removes* pi's documentation-routing section. The
  STE guidance itself is kept concise so it costs the least per cached turn. The
  Bash-output summarizer is not a token source. The remaining Check-off token
  difference between pi and PUM is dominated by run-to-run turn count.

## Three-way run vs OpenCode (2026-08-13)

Both pi and pum use their normal layouts; OpenCode runs via
`opencode run -m litellm/ds4-ops --auto` with per-exercise git isolation.
Same `ds4-ops` model throughout. Run: `--track js --limit 5 --agents pi,pum,opencode`,
Check mode off, one run per exercise with the runner order alternated.

### Pass / fail

| Agent | Passed |
|---|---|
| **pum** | **5/5** |
| opencode | 5/5 |
| pi | 3/5 |

### Per-exercise time (seconds) and tokens

| Exercise | pi | pum | opencode |
|---|---|---|---|
| affine-cipher | 23.9s / 103k | 22.0s / 105k | 200s timeout / n/a |
| alphametics | 48.6s / 203k | 40.9s / **119k** | 138.5s / 151k |
| beer-song | **FAIL** 14.8s | 24.7s / 159k | 80.6s / 171k |
| binary | 19.8s / 95k | 20.6s / 97k | 88.8s / 109k |
| book-store | **FAIL** 5.8s | 31.1s / 151k | 118.1s / 137k |

PUM is the fastest of the three on average (~28s/exercise) and about 3-4x faster
than OpenCode, which reliably solved every exercise but took 80-200s each.
PUM also beat pi on pass rate (5/5 vs 3/5 here) at comparable token use. This is
a small sample on the runnable js track; the same model is noisy, so treat the
pass numbers as directional, not exact.
