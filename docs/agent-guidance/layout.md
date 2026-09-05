# Source layout

Current navigation map; paths are repository-root-relative. Read the relevant modules, not just their descriptions. See the [topic index](README.md).

<a id="layout"></a>

## Layout

| File | Job |
|---|---|
| `src/index.tsx` | Side-effect-free CLI dispatch for help, version, errors, and dynamic startup |
| `src/cli.ts` | CLI parsing, package metadata, help text, and error formatting |
| `src/outer-sandbox.ts` | Canonical mount validation and deterministic claudebox launch planning |
| `src/outer-sandbox-launch.ts` | PUM child command, runtime/state mounts, and outer child context |
| `src/outer-sandbox-process.ts` | Protocol probe and shell-free claudebox process execution |
| `src/main.tsx` | Boot: config dir, login hand-off, credential check, session, render |
| `src/model-catalog.ts` | Missing-model fallbacks that preserve provider methods and prefer upstream entries |
| `src/headless.ts` | Non-interactive `-p` one-shot: core coding tools, Check mode, no UI surfaces |
| `src/app.tsx` | The TUI — state, keyboard dispatch, agent events, layout |
| `src/theme.ts` | Semantic colour tokens, nine presets, `theme.json` merge |
| `src/popup-frame.tsx` | Shared responsive popup frame and semantic drop shadow |
| `src/animation.tsx` | One frame clock; the glow core; shimmer, spinner, caret |
| `src/status-bar.tsx` | Top bar; always one measured row with responsive field priorities |
| `src/transcript.tsx` | Row rendering per role |
| `src/bash-tail-text.ts` | Native wrapped Bash tail viewport that leaves wheel input to the transcript |
| `src/output-minimal.ts` | Mode-dependent grouping: Quiet folds all settled calls; Normal groups routine successful calls |
| `src/transcript-dwell.ts` | How long a row must stay put before it may change |
| `src/transcript-window.ts` | Which rows are mounted, and when older ones join them |
| `src/tool-row.ts` | One spelling of a tool row, for live events and for replay |
| `src/tool-preview.ts` | Diff, write, and Bash previews, and inline diff trimming |
| `src/syntax-grammars.ts` | Registers the tree-sitter grammars vendored under `assets/` |
| `src/tool-line.ts` | Which argument to show, and `+n −n` from mutation patches |
| `src/questionnaire.ts` | Model tool, request queue, answer state, and main/child bridge |
| `src/tool-groups.ts` | Hidden tool groups, the `enable_tools` tool, and per-session persistence |
| `src/mcp.ts` | Main-TUI-only MCP consent, runtime lifecycle and static tool bridge |
| `src/mcp-config.ts` | Inert bounded exact-cwd MCP proposals and identity-checked reads |
| `src/mcp-process.ts` | Mandatory Linux native readonly/networkless MCP process policy |
| `src/mcp-protocol.ts` | Bounded pinned 2025-11-25 tools-only stdio MCP client |
| `src/lsp.ts` | Main-TUI-only direct-consent document diagnostics lifecycle and cached agent feedback |
| `src/lsp-files.ts` | Inert bounded LSP proposals and identity-checked Python document snapshots |
| `src/lsp-protocol.ts` | Bounded LSP 3.17 document-only pull-diagnostics stdio profile |
| `src/questionnaire-popup.tsx` | OpenTUI questionnaire popup and responsive layout |
| `src/git-branch.ts` | Reads and watches `.git/HEAD` |
| `src/syntax.ts` | Theme → `SyntaxStyle` for markdown and code highlighting |
| `src/history.ts` | Prompt-history adapter for the shared prompt cache |
| `src/prompt-stash.ts` | Prompt-stash adapter for the shared prompt cache |
| `src/prompt-cache.ts` | Reconciliation, retention, migration, and atomic persistence |
| `src/memory-identity.ts` | Stable Git common-directory or non-Git directory identity for project memory |
| `src/memory.ts` | Bounded Markdown memory, atomic revision edits, context injection, and model tools |
| `src/memory-context.ts` | Runtime-private per-window memory snapshots and append-only replacement updates |
| `src/operational-context.ts` | Runtime-private append-only capacity and effective-policy observations |
| `src/runtime-settings.ts` | Immediate tightening and all-affected-runtimes-idle relaxation coordination |
| `src/message-cache.ts` | Agent cache tools, ownership, stable IDs, and App execution bridge |
| `src/image-paste.ts` | Clipboard image capture and temporary-file lifecycle |
| `src/text-paste.ts` | Bounded local clipboard text capture for secure login fields |
| `src/pasted-text.ts` | In-memory pasted-text payloads, editor markers, and literal expansion on send |
| `src/clipboard.ts` | Completed text selection copy routes for native clipboards and OSC 52 |
| `src/worktree.ts` | Create, inspect, merge, and remove managed Git worktrees |
| `src/subagents/manager.ts` | Parallel agent sessions, routing, persistence, and tools |
| `src/subagents/spawn-preview.ts` | Requester-bound preview queue and approval settlement |
| `src/subagents/spawn-preview-popup.tsx` | Responsive Markdown preview and optional note input |
| `src/subagents/readonly.ts` | Fail-closed readonly child tool guard |
| `src/replay.ts` | Rebuilds transcript lines from a resumed session's entries |
| `src/context-window.ts` | Calibrated runtime-local budgets and deferred, persisted context rollover |
| `src/context-estimate.ts` | Conservative shared text/image estimates and bounded usage calibration |
| `src/context-recovery.ts` | Synthetic-window recovery guidance from actual active capabilities |
| `src/context-guidance.ts` | Stable system-prompt guidance for proactive context management |
| `src/transcript-history.ts` | Session-scoped transcript search and bounded text/image recovery |
| `src/queue-recall.ts` | Atomic newest-first recall of queued user messages |
| `src/session-resume-alias.ts` | Trusted source/worktree pointers to one canonical relocated session JSONL |
| `src/session-history-metadata.ts` | Bounded session JSONL metadata and usage index |
| `src/session-lock.ts` | Cross-process canonical session ownership and crash recovery |
| `src/session-lock-runtime.ts` | Locked startup, runtime replacement, and disposal |
| `src/session-history-popup.tsx` | Responsive session history list and metadata rows |
| `src/settings-popup.tsx` | The Ctrl+P panel. Presentational; owns no keyboard logic |
| `src/model-command.ts` | Exact model matching, supported effort validation, and slash argument completion |
| `src/login-popup.tsx` | Presentational provider login and custom-provider popup |
| `src/login-controller.ts` | Provider auth state machine and popup keyboard actions |
| `src/login-flow.ts` | Provider registry, custom discovery, redaction, and atomic config writes |
| `src/browser-launch.ts` | Validated direct-argv OAuth browser launch with visible fallback |
| `src/goal.ts` | Goal state, transitions, verdict validation, and atomic persistence |
| `src/goal-command.ts` | `/goal` and `/goalf` parsing |
| `src/goal-judge.ts` | Judge task, verdict schema, and bounded repository context |
| `src/goal-line.ts` | The goal label on the input-top rule |
| `src/goal-review.ts` | The inline review row: its statuses, glyphs, and colours |
| `src/settings.ts` | PUM's own `pum.json` |
| `src/check-mode.ts` | On/off Check mode for commands, mutations, and trigger processes |
| `src/check-paths.ts` | Project-scoped additional Check mode root validation and commands |
| `src/filesystem-sandbox.ts` | Process-local path boundary for file tools |
| `src/file-checkpoints.ts` | Bounded runtime-only file-tool preimages and explicit user recovery-copy export |
| `src/project-validation.ts` | Inert project proposals, direct-user runtime approval, bounded checked batch validation and evidence |
| `src/check-policy.ts` | Deterministic shell and structured-process hard rules |
| `src/check-mutation.ts` | Pre-execution edit and patch diff proposals |
| `src/check-approvals.ts` | Check mode identity model and canonical-input serializer |
| `src/bash-output.ts` | Bash output summarization: bounded head+tail view, filters, `patterns`/`full_output` args |
| `src/sandbox/types.ts` | Shared native sandbox capability, policy, and process contracts |
| `src/sandbox-policy.ts` | Canonical policy derivation, environment filtering, and fallback decisions |
| `src/sandbox/index.ts` | pi Bash override, backend selection, probing, and enforcement controller |
| `src/sandbox/linux.ts` | Linux Bubblewrap backend and direct argv construction |
| `src/sandbox/windows.ts` | Windows MXC/CreateProcessInSandbox backend and argv quoting |
| `src/triggers/manager.ts` | Process-local trigger lifecycle, limits, routing, and cleanup |
| `src/triggers/tools.ts` | Main/child trigger model tools and target authorization |
| `src/triggers/popup.tsx` | Responsive Ctrl+T trigger management popup |
| `src/writing-style.ts` | Configurable per-turn system-prompt writing guidance |
| `src/identity.ts` | PUM identity in the system prompt and pi-docs section removal, with no-op guards |
| `src/platform.ts` | Cross-platform path identities, containment, config paths, and signals |
| `src/terminal-title.ts` | Pure title formatting and best-effort deduplicated terminal updates |
| `src/orca-status.ts` | Orca-only OSC 9999 activity status formatting and deduplicated delivery |
| `src/config.ts` | Where the config dir lives |

<!-- end:layout -->
