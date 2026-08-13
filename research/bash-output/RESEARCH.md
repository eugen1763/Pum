# Research: reducing the bash tool's context footprint

**Status:** implemented and unit-tested (`src/bash-output.ts`), wired into the
bash tool extension, benchmarked head-to-head against pi's built-in tool.

## 1. The problem

`bun test` and similar commands print hundreds of lines. pi's bash tool keeps the
**last 2000 lines or 50KB** of output and puts it into the conversation. That is a
lot of tokens for one tool call, and most of those lines carry no signal.

Baseline measured on real commands:

| command | bytes pi sends to context |
|---|---|
| 3000-line generator loop | 51 297 |
| failing loop (400 lines, exit 1) | 3 544 |
| `git log --oneline -300` | 14 101 |
| `ls -R node_modules/@opentui \| head -2500` | 8 548 |
| 5000-line noisy stream | 37 612 |

## 2. How pi's bash tool works today

`node_modules/@earendil-works/pi-coding-agent/dist/core/tools/bash.js`:
`OutputAccumulator` (`output-accumulator.js`) keeps a rolling tail, streams the
full output to a temp file once it exceeds the limits, and `truncateTail`
(`truncate.js`) cuts to:
- `DEFAULT_MAX_LINES = 2000`
- `DEFAULT_MAX_BYTES = 50 * 1024`

pi's marker points at its full-output temp file only after pi's 50KB limit is
crossed. PUM now uses a separate trusted capture file for every summarized call,
so output between PUM's smaller limit and pi's 50KB limit is also recoverable.

## 3. Methodology

I built a benchmark harness under `research/bash-output/`:

- `datasets.ts` — 18 generated outputs that mimic real commands. Each carries an
  **anchor**: the exact substring the model must still see to do its job.
- `policies.ts` — the output-policy engine (pure functions): strategies, filters,
  byte bounds, pattern pass-through.
- `bench.ts` — policy x dataset matrix. Metric: **context bytes** =
  `byteLen(result content that would be recorded in the session)`.
- `live.ts` — drives the REAL pi bash tool and the REAL wrapped tool
  (`withBashOutput`) on actual commands, measuring the exact returned content bytes.

A policy is judged useful only if it keeps every anchor **and** shrinks bytes.
The full-output file is the escape hatch for everything a summary drops.

## 4. Test cases (the 18 datasets)

| id | simulates | what must survive |
|---|---|---|
| testPass | `bun test`, all pass | trailing summary |
| testFailEnd | `bun test`, failure at the END | FAIL + summary |
| testFailMid | `bun test`, failure in the MIDDLE | the FAIL block + summary |
| lsRecursive | `find . -type f` (4000 paths) | an early file AND the last entry |
| gitLog | `git log --oneline` (2200 commits) | the NEWEST commit (first line) |
| compileProgress | build tool, 3000 near-identical lines | final "done" line |
| npmInstall | npm progress dots + summary | `added N packages` |
| singleHugeLine | one 200KB JSON line | the trailing delimiter line |
| ansiColored | ANSI-colored test output | the summary at the end |
| repeats | 6000 identical lines | the repeated content |
| dotMatrix | 8000 dots + `OK` | the `OK` line |
| bannerMidWarn | banner + mid warning + noise | the warning AND the end |
| failHugeLine | one huge error line (exit 1) | the trailing anchor |
| uniqueList | 5200 unique paths, one target at 2517 | the buried target file |
| patternTarget | target line buried at 1500 | the target token |
| interleavedWarnings | dots interleaved with warnings | a mid warning |
| jsonSummary | verbose log + trailing JSON | the JSON totals |
| versionList | 3000 near-identical numbered lines | the TOTAL line |

The hard cases are the **middle-anchored** ones (`testFailMid`, `bannerMidWarn`,
`uniqueList`, `patternTarget`, `interleavedWarnings`): a pure tail or pure head
drops them.

## 5. Results — strategy family at a fixed 4KB budget

| policy | total bytes (all 18) | anchors kept | avg reduction |
|---|---|---|---|
| summary-only | 1 761 | 0 / 18 | 2 999x |
| **head+tail** | 42 981 | 14 / 18 | 1 242x |
| tail (current shape, shrunk) | 46 590 | 13 / 18 | 1 238x |
| head | 41 118 | 10 / 18 | 1 247x |
| **pi baseline** | **716 982** | **15 / 18** | 1 191x |

Takeaways:
- `head` loses every end summary (testPass, testFailEnd, compileProgress,
  npmInstall, jsonSummary, versionList, ...). 10/18.
- `tail` loses every head/middle anchor (gitLog, lsRecursive, testFailMid,
  uniqueList, patternTarget, bannerMidWarn). 13/18. **pi's current tail already
  loses `git log` heads, listing heads, and mid-stream failures** even at 50KB.
- `head+tail` is the only single strategy that keeps both ends. 14/18 without any
  filtering or pass-through.

## 6. Results — the filters and pass-through push it to perfect

| policy | total bytes | anchors kept |
|---|---|---|
| head+tail 3KB, ANSI+noise filter | 33 403 | 14 / 18 |
| + repeat compression | 25 595 | 15 / 18 |
| + similar-line compression | 6 717 | 17 / 18 |
| + keepImportant (error/warning pass-through) | 6 717 | **18 / 18** |
| + tailOnError | 6 717 | 18 / 18 |

### What each piece does

- **ANSI strip** removes escape codes that once counted toward the byte budget
  (`ansiColored` 51 213 → ~4 KB).
- **Repeat compression** turns `N` identical lines into `N x <line>`
  (`repeats` 51 KB → 194 B).
- **Similar-line compression** collapses runs of lines that differ only by
  numbers, keeping the first 3 and last 2 real lines (`Compiling package 5 of
  3000` → 3 real lines + a marker). This is what collapses build noise and also
  makes a single unique line "pop out".
- **keepImportant** re-injects `FAIL` / `error` / `warning` lines from the elided
  middle (rescues `testFailMid`, `interleavedWarnings`, `bannerMidWarn`).
- **tailOnError** switches to the tail on a non-zero exit, because that is where
  the crash details live.

### Honest caveat discovered while benchmarking

`similar-line compression` originally flattened runs entirely, which **destroyed
`git log`** (every commit hash reduces to the same "shape"). The fix: keep the
first few and last few real lines of every run verbatim. This also rescued the
"last entry of a uniform listing" case.

## 7. Results — budget ladder (head+tail, all filters, 18/18)

| budget | total bytes | reduction vs baseline |
|---|---|---|
| 1 KB | 4 623 | ~155x |
| 2 KB | 5 714 | ~125x |
| 3 KB (default) | 6 717 | ~107x |
| 8 KB | 6 717 | ~107x |
| 16 KB | 6 717 | ~107x |

Above ~1 KB the filters already collapsed most output, so bigger budgets rarely
add bytes here; the real headroom is spent only when output genuinely differs
line by line (e.g. `git log`).

## 8. Results — real commands through the REAL wrapped tool (live.ts)

The production path tees the exact stream to a PUM-owned private temp file, then
`withBashOutput` re-renders the trusted capture. It never parses a path from
stdout, stderr, or an error message.

| command | pi baseline | PUM wrapped | reduction |
|---|---|---|---|
| 3000-line loop | 51 297 | 327 | **157x** |
| failing loop (exit 1) | 3 544 | 240 | 14.8x |
| `git log --oneline -300` | 14 101 | 2 730 | 5.2x |
| `ls -R node_modules/@opentui \| head -2500` | 8 548 | 1 344 | 6.4x |
| 5000-line noisy stream | 37 612 | 386 | 97x |
| tiny `bun test` subset | 80 | 185 | 0.4x |

The trusted full-output marker can add a small fixed cost when a tiny result is
changed by ANSI/noise filtering. Large noisy commands still shrink by 5-157x.

## 9. Tool-arg variations tested

The schema adds four per-call arguments beyond the current `command`/`timeout`:

| arg | effect | measured |
|---|---|---|
| `full_output: true` | bypass summarization, return pi's native output | works; tested |
| `strategy: "headTail" \| "sample" \| "tail" \| "head"` | per-call cut strategy | tested (section 5) |
| `max_bytes: n` | per-call byte budget | tested (section 7) |
| `patterns: string[]` | regexes whose matching lines survive elision | **demo below** |

### Patterns = "regex the model can add to extract what it is looking for"

Real demo (mid-stream target buried in 4800 unique lines, no collapse possible):

```
MID TARGET TEST: bytes 2014 -> 2063 | target present without patterns: false | with patterns: true
```

Without `patterns` the target line sits in the elided middle and is dropped.
With `patterns: ["CACHE_IMPL_V2"]` the line is re-injected (+49 bytes). The model
pays only for the lines it explicitly needs.

## 10. Findings summary

1. pi's 50KB tail is not only large, it **loses information**: git tails, listing
   heads, and mid-stream failures all vanish.
2. **head+tail is the right shape**; tail-only and head-only each drop ~5 anchors.
3. The cheap filters (ANSI, noise, repeat, similar-line) are free wins and are
   what turn `bun test`-style output from kilobytes into tens of bytes.
4. **keepImportant + tailOnError close the last gap** — failures and warnings are
   never silent.
5. Huge unique listings cannot be summarized losslessly; the answer is
   `patterns` (targeted extraction) plus the full-output file pointer.
6. The full output is **never deleted**: every summary either shows everything or
   points at the temp file, so nothing is truly unrecoverable.

## 11. The chosen design (implemented)

Default PUM policy (`DEFAULT_BASH_OUTPUT` in `src/bash-output.ts`):
- `strategy: "headTail"`, head 30, tail 40
- byte budget 3072 (3 KB), sample 20 for `"sample"` mode
- filters: ANSI strip, noise drop, repeat compress, similar-line compress
- keepImportant on, tailOnError on
- marker only when something was elided (keeps tiny outputs byte-identical)

### Files changed

| file | change |
|---|---|
| `src/bash-output.ts` | new: policy engine + `withBashOutput` wrapper + settings |
| `src/sandbox/index.ts` | all three bash-tool creation paths wrapped |
| `src/settings.ts` | `bashOutput` config (optional, defaults on) + normalize |
| `src/headless.ts`, `src/main.tsx` | load `bashOutput` at startup |
| `src/settings.test.ts` | round-trip + migration expectations updated |
| `src/bash-output.test.ts` | 25 unit tests (filters, bounds, patterns, wrapper) |

## 12. Security and correctness review fixes

A later review found and fixed five defects:

1. Forged `Full output:` text can no longer cause a host file read. Only the
   PUM-owned capture path is read.
2. `patterns`, `strategy`, `max_bytes`, and `full_output` are registered in the
   model-visible outer Bash schema.
3. Explicit patterns run against normalized raw lines before filtering or
   compression.
4. Extracted lines and the marker are included in one final hard byte budget.
5. PUM preserves complete summarized output even below pi's native 50KB limit.

### Follow-ups worth doing
- A settings-popup toggle for "summarize bash output" (on/off/budget).
- Document the `patterns`/`full_output` args in the bash prompt snippet so the
  model uses them proactively.
- Watch for pi upgrades: the wrapper reads `details.fullOutputPath` from pi's
  bash tool; if pi changes that shape the wrapper must follow (the tests pin it).
