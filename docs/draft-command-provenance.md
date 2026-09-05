# Direct-user command drafts (#70)

`/mcp`, `/lsp`, `/validation` and `/checkpoint` are App-only runtime operations, not
model/SDK commands. Their authority now comes from the submitted draft's origin,
not from its text or a mutable cache row index.

## Policy

- A new empty editor accepts a direct-user draft. Typing, editing, command/path
  completion and attachment insertion preserve that draft's origin.
- Cache checkout/execution, history recall, queued-message recall, quoted text,
  cancelled-turn text and failed-send restoration are **restored**, not direct.
  Editing restored text does not upgrade it, even if every character changes.
- No-op history navigation leaves origin untouched. Navigating back down to a
  saved history draft is conservatively a restoration too, even if it originally
  came from fresh typing.
- Switching agent views saves/restores each draft's origin separately from its
  cache index. Deleting or reindexing stash rows cannot change origin. Offscreen
  queued/quote/failed-background restores explicitly save restored origin.
- Clear a nonempty draft with **Ctrl+C**, then type anew to issue a direct command.
  Ordinary editing/deletion is not an authority reset. Submitting a rejected
  command also leaves a new empty editor, as other command submissions do.
- The same conservative rule covers **all** four command families, including
  LSP preview/connect/check/problems/status/stop,
  MCP preview/status/revoke/disconnect, validation preview/status/disable and
  checkpoint list. Restored text never invokes their controllers. Fresh explicit
  revoke/disable retains its existing busy-runtime availability.

## Implementation contract

`src/app.tsx` holds `direct`/`restored` origin in a synchronous ref. The origin is
fixed for a draft across ordinary edits; it is not inferred from current text,
history cursor or `editingStashIndex`. `setEditorText` defaults every nonempty
programmatic installation to restored. Only completion/attachment transformation
and explicit per-view state restoration provide an existing origin. Empty editor
installation starts a new direct draft.

`submitPrompt` snapshots eligibility before clearing input. Explicit value/cache
execution cannot be direct. The two keyboard-completion submissions preserve the
current origin rather than granting authority; plain Enter and textarea `onSubmit`
use the same boundary. Selected-stash execution uses explicit cached value/index;
range execution uses main-agent orchestration rather than command dispatch.

All nonempty `setEditorText` call sites were reviewed: cache checkout, quotes,
queued/cancelled turns, steering fallback, shell/goal/background errors, failed
submission, history navigation, view switches, completions and attachments.
Programmatic error/restoration paths deliberately default to untrusted even when
this means the user must clear and retype a previously direct draft.

Origin is runtime-private UI state. It is not a model-controlled flag and is not
persisted to history, cache, session JSONL or configuration. Existing role, exact
runtime, idle and controller digest/path checks remain separate requirements.
This is not protection against arbitrary code execution inside the App process,
OS input automation, or a user choosing to clear and retype/paste untrusted text.
Other slash-command families are outside this prerequisite's scope.

## Rendered regressions

`tests/mcp-ui.test.tsx` uses OpenTUI's real renderer/input dispatch with bound
validation/checkpoint controllers and injected MCP/LSP controllers. Tests assert
both rendered refusal and absence of controller calls, not source patterns alone.

Coverage includes single cached execution, checkout+Enter, the exact
Tab/Up/Tab/Down/Enter empty-history reproduction, checkout+Up/Down/Enter with
nonempty history, edits (including replacing every character), argument completion,
agent-view restoration, deleting a checked-out stash row
from another view, failed delivery followed by editing/history, queued worker
recall/view restoration, and main text-only steering-queue recall. The five
original sensitive commands (MCP connect/approve, validation enable, checkpoint
recover/clear), plus LSP connect/check, share the matrix. Preview/revocation completion remains inert for cached
drafts; clearing/retyping and fresh per-view drafts remain functional.

LSP is main-TUI-only. Every runtime creates a fresh controller using the mandatory
MCP readonly/networkless process adapter, binds the exact session, and disposes it
on retirement. Main Esc cancellation withdraws LSP authority alongside MCP. No
startup/resume consent is restored, no SDK slash command is registered, and
headless and worker runtimes import no LSP controller. The hidden main-only LSP
group exposes only cached `lsp_diagnostics`; revealing it does not connect a server
or check a file. `/lsp problems` produces compact transient transcript output,
not a modal, automatic model context, or a repair turn.

The fixtures do not launch a real MCP/LSP server or test native confinement. Adjacent
rendered validation/checkpoint, cache, queue, clear-input, delivery and completion
suites protect their existing behaviors. Native MCP policy and its enforcement
limitations are documented separately in `docs/mcp.md`.
