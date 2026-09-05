# Context-window capability inspection

## Reference

- Repository: https://github.com/fitchmultz/pi-posthorse
- Source inspected completely: `README.md` and `index.ts` on `main`, resolved
  with `git ls-remote` to `6f97656910f32040bbb274187d973f3b90de0c43`.
- Recorded SHA-256 of the pinned source: README
  `5b879482bd0e6acf848361ca6d04c6ab903d905dad8b5a05e03f53fad623d797`;
  index.ts `fbf27aec202e87f43269f74a6c127450a82bc541e03c3a8c644c35a95505acbe`.
  GitHub's commits API returned HTTP 403; raw source and Git ref reads succeeded.
- The reference requires `fitchmultz/pi`, not the published pi package.
- Its README identifies fork revision `f9b06177e565f70cd243a785d088d1c491830dbd`.
- Its source checks for `ctx.newContext`, `ctx.getCompactionSettings`, and
  `ctx.getSystemPrompt`. Its automatic policy uses `session_before_auto_compact`.
- It registers `history`, `get_context_remaining`, and `new_context`, plus notes.
- Explicit rollover commits after the complete successful tool batch. Transcript
  entries remain available, while the active model window changes.

## Recorded local evidence

`package.json` specifies `@earendil-works/pi-coding-agent` 0.85.0-compatible
packages. Its installed `node_modules` package manifest confirms version 0.85.0.
The following installed source and declaration files were inspected:

- `dist/core/extensions/types.d.ts`: `getContextUsage`, `context`, `turn_end`,
  and `session_before_compact` exist. `newContext`, `context_window`, and
  `session_before_auto_compact` are absent.
- `dist/core/session-manager.d.ts`: session trees are append-only. Custom entries
  store extension state without becoming model messages. `getEntries` returns
  transcript entries; `getBranch` selects the active branch.
- `dist/core/agent-session.js`: tool results persist before extension `turn_end`.
  `prepareNextTurnWithContext` refreshes the inner tool loop. Automatic
  compaction normally calls a summarization model, then rebuilds active messages.
  Manual `AgentSession.compact()` resolves summarization authentication, then
  passes `sessionManager.getBranch()` to `prepareCompaction` before emitting
  `session_before_compact`.
- `dist/core/compaction/compaction.js`: `prepareCompaction` reads the persisted
  branch, respecting native compaction entries but not PUM rollover boundaries.
  Archived PUM windows remain eligible for summarization. The synthetic literal
  handoff in active model messages is not part of this preparation.
- `dist/core/settings-manager.js`: `applyOverrides` changes effective settings
  without saving defaults. Reload replaces these effective overrides.
- `dist/index.d.ts`: public exports include `sessionEntryToContextMessages`,
  `estimateTokens`, and `calculateContextTokens`.

PUM sources inspected:

- `src/main.tsx`, `src/headless.ts`, `src/subagents/manager.ts`: independent
  session service construction and extension registration paths.
- `src/tool-groups.ts`, `src/subagents/readonly.ts`: explicit outgoing tool lists
  and a fail-closed readonly tool allowlist.
- `src/memory.ts`: project memory is injected on each context event.
- `src/replay.ts`: transcript replay reads retained entries, not only model input.
- `src/app.tsx`: `/compress` delegates to pi's manual compaction API.

The initial inspection found no PUM `history`, `new_context`, or
`get_context_remaining` tool. Posthorse cannot be installed unchanged against
these inspected APIs. PUM uses its own persisted boundary and runtime integration;
no pi fork or installed dependency mutation is required.

## Manual compaction incompatibility

Native manual compaction does not summarize PUM's active window. It can summarize
archived windows and omit the literal handoff. Filtering model messages after
compaction cannot correct that summary input. The `session_before_compact` hook
also runs too late to prevent native preparation or authentication preflight.

The controller therefore refuses manual `/compress` when a PUM rollover boundary
is active, before entering native compaction. Manual compression before the first
rollover remains unchanged. `new_context` remains supported, and the complete
transcript stays available through `history` and replay.

## Scope

Implement the requested explicit rollover and recovery tools for TUI main,
headless main, and managed workers. Keep internal judges and AFK delegates
unchanged. Recovery uses the calling session only, with no arbitrary session
path or cross-agent configuration-directory read. Existing private project
memory remains the durable-notes mechanism.

Differences from the reference are deliberate:

- This implementation supplies explicit rollover, not Posthorse's automatic
  rollover/reminder policy. Automatic pi summaries are disabled locally in these
  runtimes. Manual `/compress` is refused with an active PUM rollover boundary,
  as explained above. The remaining-context tool must not describe the reserve
  as an automatic rollover threshold.
- A PUM `custom` entry persists each boundary; pi's native entry union and JSONL
  version do not change. Context projection follows the selected branch and is
  rebuilt when the same session resumes. The complete transcript remains in the
  same canonical file.
- `history` does not implement Posthorse's cross-session `all` scan. PUM's worker
  and credential boundaries require session ownership to remain authoritative.
- Structural-entry reads return metadata only, so `parentId` traversal can cross
  non-message entries without exposing private custom data.
- Recovery pages execute sequentially and budget prior history results in the
  same tool batch. Pages are bounded and returned as historical data, not new
  user instructions. Excluded shell output stays excluded.
