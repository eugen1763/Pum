# Historical research and evidence — not current authority

The [current guidance index](README.md) and root [AGENTS.md](../../AGENTS.md)
route implementation work. The following material records past investigation,
benchmarks or implementation stages. It does not grant execution/consent, supersede
current constraints, establish present performance, or authorize paid benchmarks.
Read it only when the corresponding task needs its evidence; reverify relevant
source/dependencies before relying on old API observations.

| Historical material | Use and limits | Current authority |
|---|---|---|
| [Context-window inspection](../../research/context-window/README.md) | Original fork/SDK investigation; “initial inspection found no tools” describes the preimplementation state, not current capability | [Session/context contracts](sessions-context.md), [budgets](../context-budgets.md), [history](../transcript-history.md) |
| [Bash-output research](../../research/bash-output/RESEARCH.md) | Historical datasets, byte reductions, experiments and then-current SDK internals; not a new benchmark or guarantee | [Bash-output contract](agents-tools.md#ld-034), [tools](../tools.md), [security](security.md) |
| [PUM/pi/OpenCode benchmark](../../research/bench-pi-vs-pum/README.md) | Past environment/provider comparisons and optional harness requiring separate execution authority; no current quality, cost or compatibility claim | [Architecture](architecture.md), [CLI](../cli.md), [security](security.md) |
| [Implementation cautions](implementation-cautions.md) | Historical incidents and measurements explain still-current mandatory safeguards; do not discard the prescriptions with the anecdotes | [TUI contracts](tui.md), [security](security.md), [TUI testing](testing.md) |
| [Hosted-search observations](agents-tools.md#ld-104) | Unversioned live anecdotes are not invariants; disabled hosted search does not promise any model fallback behavior or arbitrary Bash isolation | [Search dispatch/revocation](../operational-settings.md#hosted-search-and-revocation), [diagnostics distinctions](../request-diagnostics.md) |
| [MCP historical validation](../mcp.md#validation-and-limitations) | September 5, 2026 recorded fixture results and absent-Bubblewrap limitation, not a new run or interoperability claim | [MCP scope/consent](../mcp.md#accepted-scope-and-residual-risk), [security contracts](security.md#ld-112) |

## Clarifications recorded in this migration

All original units remain mapped in [migration.json](migration.json), with the
old heading/source interval/digest and current anchor. Evidence-backed changes
are tagged `clarified` and have a rationale plus source/test paths. These changes
correct documentation, not runtime policy:

- Scope config defaults by platform; scope unsandboxed Off to ordinary mutable
  Bash and “TUI never sandboxed” to the inner controller, not outer claudebox.
- Align structured-trigger review with the existing deterministic/advisory
  implementation, retaining hard blocks, abort, stale-epoch rejection and no
  structured npm exception.
- Distinguish OpenTUI's five upstream parsers from PUM's five extra offline
  vendored grammars. Runtime downloads are not the implemented path.
- Scope core/hidden tools by audience, include Shells/Todo/MCP/LSP, and preserve
  reveal-is-not-consent and restricted-role omissions. Include LSP in the shared
  direct-draft-origin family, as already required by its own original contract.
- Qualify historical hosted-search probes and retain newer revocation requirements.
- Align Quiet's layout/usage description to all settled calls, not only successes.
- Treat key summaries as normal-input-mode summaries, not overrides of the current
  documented Alt+I multiline mode. Preserve all original keys and exact UI rules.
- Remove obsolete MCP pre-integration task instructions after confirming #45 is
  closed; retain the dated evidence, residual risk and missing-native limitations.

The [dist-tag scope discrepancy](security.md#policy-wording-ambiguity) remains
explicitly unresolved. This docs-only migration must not decide broader release
permission, change implementation, or conceal the mismatch. Original overlapping
Check bullets remain co-located and explicitly reference one policy; shared
UI/ref-timing cautions remain co-located rather than deleting examples or constraints.
