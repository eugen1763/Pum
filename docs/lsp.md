# Explicit local document diagnostics (LSP MVP)

PUM's minimal language-server integration provides **Python `.py` document-only
pull diagnostics**, not general code intelligence. It does not provide completion,
hover, definitions, symbols, rename, code actions, workspace edits, type/dependency
analysis, or a project-wide error count. No named real language server has been
validated. Local fake servers exercise the supported protocol profile; PUM does
not install, download, discover, or configure a server for you.

## Configuration and consent

An exact-cwd `.pum/lsp.json` is an **inert proposal**, never startup configuration:

```json
{
  "version": 1,
  "executable": "/absolute/path/to/an/existing/conforming-server",
  "args": ["--stdio"]
}
```

The example is a placeholder, not an installation command or a compatible-server
recommendation. The strict schema accepts only these three fields. One server,
16 KiB UTF-8 configuration, absolute executable, up to 16 arguments (1024 bytes
each). No environment, auth, initialization options, network, shell wrapper
configuration, alternate cwd, additional roots, or automatic enablement fields.
Never put secrets in the proposal or argv: preview intentionally shows them.

Type these commands directly in the **idle main TUI**:

1. `/lsp` or `/lsp preview`: show argv, readonly project scope, residual exposure,
   and the exact proposal SHA-256. Nothing starts.
2. `/lsp connect <sha256>`: approve this exact previously previewed proposal and
   initialize one confined process. Approval belongs only to the bound runtime.
3. `/lsp check src/example.py`: explicitly synchronize and check one project file.
   Paths are literal relative paths (spaces permitted); no shell expansion/quotes.
4. `/lsp problems`: compact, revalidated snapshot in the transcript: filename,
   one-based line/UTF-16 character, severity and escaped diagnostic text. At most
   20 problems display; omitted problems are counted. This is not a new modal.
5. `/lsp status`: connection/request state, not a freshness assertion.
6. `/lsp stop`: revoke authority, stop the process, discard diagnostics. Also
   accepts `disconnect` and `revoke`.

**Every** `/lsp` operation requires direct-user draft provenance, including
preview/status/problems/stop. Cached, stashed, historical, queued, programmatically
restored or model-produced commands cannot grant or change consent. Editing,
completion, or no-op navigation does not upgrade a restored draft. Clear with
Ctrl+C and type anew. No SDK slash command or model tool invokes these commands.
See `draft-command-provenance.md`.

## Process boundary and residual risk

The adapter is the **unchanged reviewed MCP confined process adapter**, not the
ordinary Bash fallback path. Linux Bubblewrap is mandatory even with Check and
Sandbox Off. Unsupported platform, missing/failed native probe, invalid boundaries,
or exceeded sensitive-scan bounds refuses connection. There is no unsandboxed
fallback. No network, user environment/auth passthrough, or additional Check roots.
Only readonly live cwd, minimal readonly system runtime mounts, and the exact
external executable file are exposed. Scratch is private and writable; project
and configuration writes are not authorized. PUM configuration is denied.

The same MCP caveat applies explicitly to each LSP preview: bounded sensitive-name
masks are **defense in depth, not a secret-free snapshot**. Arbitrary secrets,
aliases, future files, and project/server code may be read and returned to the
model. Approval trusts current/future server and project code within that confined
readonly exposure. It does not authorize writes, network, installation, credentials
or authentication. The adapter's scan limits and check-time races are documented
in `mcp.md`. There is no host broker. Native-enforcement evidence must not be
inferred from fake-transport tests; on hosts without Bubblewrap those tests skip.

## Exact protocol and server profile

- Language Server Protocol **3.17** subset, JSON-RPC 2.0 over local stdio,
  `Content-Length` framed UTF-8, UTF-16 positions. LSP has no numeric version
  handshake: capability checks enforce this profile.
- `initialize`, `initialized`, full text `textDocument/didOpen` / `didChange`,
  `didClose`, `textDocument/diagnostic`; one open document and one pull at a time.
- Require full synchronization (`textDocumentSync: 1`, or
  `{ "openClose": true, "change": 1 }`), absent/`utf-16` position encoding,
  and `diagnosticProvider` explicitly advertising
  `interFileDependencies: false` and `workspaceDiagnostics: false`.
  This intentionally excludes cross-file typecheckers and incremental-only or
  push-only servers. Servers must support document-only Python linter-like pulls.
- Full reports only. No prior-result-ID/unchanged cache, related-document URI
  following, workspace pulls, partial progress, push diagnostic ingestion,
  auto-retries, server-driven rechecks or configuration callbacks. Refresh capability
  is not advertised; `workspace/diagnostic/refresh` requests receive unsupported
  method (-32601), but both requests and notifications invalidate diagnostic evidence.
- Server descriptions/logs/stderr never become instructions. Unsupported server
  requests, including `workspace/applyEdit`, commands and registration requests,
  receive no execution authority. No client filesystem write RPC exists.
- Bounds: 1 KiB header, 256 KiB frame, 16 MiB total stdout / 1 MiB stderr,
  4096 incoming messages per connection, eight pending writes; 100 diagnostics,
  1 KiB sanitized message each and 32 KiB projected diagnostic result. Exceeding
  counts/results fails closed rather than silently reporting a partial clean bill.
  Startup is bounded to 10 seconds, a pull to 15 seconds, normal shutdown to
  500 ms. Adapter process scanning/writes/cleanup have their own tighter limits.
  Cancellation and failures terminate the connection rather than keeping a
  partially synchronized server. Normal client close attempts bounded
  shutdown/exit; revoked authority aborts immediately.

## Freshness, lifecycle and agent feedback

A document must be a stable, singly-linked regular UTF-8 `.py` file (at most
128 KiB), inside the exact project, with no linked path components or credential
paths. The reader checks descriptor and named-file identity and all ancestors.
Each pull captures exact content and identity/timestamps plus a monotonic request
generation/version. Results publish only when these still match after completion.
Exposure through `/lsp problems` and the agent tool re-reads that fingerprint.
Deletion, replacement (even same bytes), editing, cancellation or stale generations
withdraw rather than return old evidence. File/ancestor watchers invalidate
observed changes; bounded synchronous boundary reads do not rely on watcher timing.
These are check-time safeguards, not atomic isolation against concurrent writers.

An explicit `workspace/diagnostic/refresh` request or notification immediately
withdraws the cached generation. If a connect/check is pending, it cancels the
connection and revokes authority; late pull responses cannot restore evidence,
including responses already received but not yet published. An idle connection
may remain approved with no snapshot; only another direct `/lsp check` creates
new evidence. Refresh never grants consent, rechecks, restarts, steers or injects
context automatically.

Freshness is limited to the selected-file fingerprint and observed invalidation
signals. Unknown or unobserved linter configuration changes and server-internal
state changes can make a snapshot stale without changing that fingerprint. PUM
does not monitor every server dependency or prove full diagnostic currency, even
for an empty report. Explicit refresh handling does not remove this limitation.

Mutation-capable agent tools conservatively withdraw cached evidence, even if a
particular call later fails. An edit during a pending pull cancels its connection.
Proposal bytes/path changes, monitoring errors, process/protocol failures,
user cancellation, aborted/error turns and runtime disposal revoke trust. A
pending connect/check is cancelled if an agent turn starts. Relocation or session
replacement disposes the old controller; restart, resume and new runtime creation
inherit **nothing**. No automatic process restart or background checking follows.

The optional **main-only LSP tool group** contains one static `lsp_diagnostics`
tool. Revealing it grants no process authority. It reads only the explicitly
user-requested cached snapshot, checks exact session-manager object/session ID/cwd,
and revalidates the selected file. It cannot select a file, contact a server,
connect, approve, mutate, repair, or start another agent turn. Empty/unavailable
snapshot does **not** mean error-free. Messages are bounded escaped untrusted data.

No automatic context injection, steering, repair loop or persistent diagnostic
cache exists. Ordinary command/tool output remains historical transcript data;
**previously delivered copies cannot refresh or be recalled after later edits**.
Fetch the tool again for evidence revalidated against the selected file, subject
to the unobserved-change limits above. Scope is the selected document, never
workspace consistency. Server correctness remains untrusted.

Workers (including mutable workers), readonly children, judges, AFK delegates and
**headless `-p` have no LSP controller, tool or consent path**. Headless LSP is
explicitly unsupported, not silently enabled by repository proposals or CLI text.

## Primary protocol references

Official Microsoft LSP 3.17 specification: base framing, initialization/lifecycle,
text synchronization, document pull diagnostics, diagnostic and position types.
The implementation design was checked against the official specification source
under `microsoft/language-server-protocol`, `_specifications/lsp/3.17`, including
`language/pullDiagnostics.md` and `general/initialize.md`. This is a pinned subset,
not a claim of latest/full LSP support. SDK integration follows the installed
pi `docs/sdk.md` lifecycle and tool contracts.
