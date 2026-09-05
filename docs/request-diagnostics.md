# Request diagnostics

Request diagnostics are an opt-in, local debugging view of request construction
and transport observations. They do **not** prove provider caching behavior.

## Enable and view

Enable diagnostics when starting PUM (POSIX shell):

```bash
PUM_REQUEST_DIAGNOSTICS=1 bun run start
```

In PowerShell:

```powershell
$env:PUM_REQUEST_DIAGNOSTICS = '1'
bun run start
```

Only the exact value `1` enables collection. Restart with the variable unset to
disable it. It is not a saved setting and cannot be enabled by a model tool.

- `/diagnostics` shows a safe JSON report for the selected transcript's session.
  Select a child transcript to inspect that child. An unavailable child session
  produces an explanation, never a process-wide fallback.
- `/diagnostics clear` clears that session's collected diagnostics. It does not
  change model context, provider state, or SDK transport state.
- When disabled, `/diagnostics` explains how to restart with collection enabled.

Headless runs print the safe JSON report to **stderr** after the run, before
teardown, only when enabled. The assistant's stdout is unchanged:

```bash
PUM_REQUEST_DIAGNOSTICS=1 bun run start -p 'Explain the project layout'
```

Reports displayed in the TUI are ephemeral: they are neither appended to session
files nor sent to the model. Headless stderr can of course be captured by your
terminal or a caller that redirects it.

## Privacy and lifetime

The collector retains at most 64 requests per runtime process, with reports
filtered to the requested session, and comparison baselines for at most 32 sessions.
Old records/baselines are evicted at those limits. Only the latest baseline keeps
per-item hashes, capped at 2,048 input items; larger inputs still receive whole
hashes and byte lengths, but report `comparison-limited` rather than a prefix verdict.
It is bounded in memory, cleared on session disposal, and writes no diagnostics
files. Resuming/replacing a session starts a fresh baseline even with the same
session ID. Clearing one session leaves other sessions' records alone.

Reports use hashes, lengths, counts, booleans, and finite classification codes.
Private project memory is represented by revision metadata only. No raw prompts,
private memory text, credentials, raw errors, raw session IDs, or provider
response IDs belong in a report. Payload fingerprints are HMAC-SHA256 with a random,
unpersisted process key, so they compare within this process, not across restarts.
Memory revisions retain the memory store's existing SHA-256 revision convention;
invalid/unavailable memory reports `unavailable`, and roles without memory report
null. These are correlation signals, not encryption; share reports deliberately
even though content is excluded.

## Read the signals conservatively

- **Full versus delta transport is not server cache hit versus miss.** A full
  request can benefit from server-side prefix caching; sending a delta does not
  establish a cache hit. The local observer cannot see a provider's internal
  cache decisions.
- **Local previous-request prefix comparisons are explanatory signals, not the
  SDK's exact continuation decision.** PUM compares request observations. The
  SDK's continuation baseline also includes the prior assistant response, so
  the two comparisons are not interchangeable.
- **SDK debug statistics are process-local, session-scoped counters.** They are
  not provider billing or server cache telemetry. Unsupported providers report
  unavailable rather than implying a zero count or a cache miss.
- Changes in tool schemas, context windows, memory revisions, or request hashes
  can help explain why successive requests differ. They do not alone prove what
  was transmitted, which continuation branch the SDK chose, or whether the
  provider reused cached computation.

## Field boundaries and validation

`payload`, `instructions`, `tools`, `nonInput`, and `input` contain only hashes
and UTF-8 JSON byte lengths. `input.items` counts serialized input items. Capture
uses the provider's effective `onPayload` body after extension transforms and
hosted-search enforcement, **before** SDK transport delta selection or compression.
The body hash/length therefore describe the full logical body, not WebSocket frame
bytes or compressed HTTP bytes. Input extraction supports `input` and `messages`;
other provider shapes report an unavailable comparison rather than a fabricated
prefix. SDKs that do not call `onPayload` expose no body measurements.

`reasons` are finite local change signals: `first-request`, `instructions-changed`,
`tools-changed`, `non-input-changed`, `input-prefix-changed`, `input-appended`,
`identical-payload`, `comparison-limited`, and `after-error`. The last means the
previous local attempt errored or aborted, not proof of an SDK retry. Requested
transport is recorded separately from observed counters; `unobserved` does not
mean SSE or a failed request.

For Codex, a lazy public `getOpenAICodexWebSocketDebugStats(sessionId)` read supplies
per-call counter differences for full/delta requests, connection creation/reuse,
WebSocket failures, and SSE fallbacks. Production transport is never forced to
SSE. An internal retry may cause several transport attempts within one record.
Direct SSE and other APIs have no such counters. Same-session overlapping calls
would make counter differences ambiguous; ordinary agent calls are sequential,
and independent delegated sessions have separate baselines. SDK counter reset
or missing exports leaves transport observations unavailable. Raw SDK error text
and previous-response IDs are deliberately discarded.

`usage` contains SDK-normalized numeric input/output/cache-read/cache-write/total
tokens from the completed assistant response. Missing, invalid, and all-zero
placeholder usage is null, not a claim that a failed request cost zero tokens.
It is not an independent billing measurement. Provider-internal HTTP retries are
not separately enumerated unless the SDK exposes them; neither hook calls nor
request equality establish how often a remote server processed an attempt.

Regression tests exercise the installed SDK with local HTTP/SSE and WebSocket
servers, including full-to-delta continuation, connection reuse, full resend after
instruction changes, and WebSocket-to-SSE fallback. Synthetic response usage
intentionally includes a full request with cache-read tokens and a delta request
without them. Other regressions cover resume, canonical tool activation, private
memory revisions, settings, retry, restricted search roles, delegated session
isolation, opt-in access, bounded retention, and redaction. No configured account
or paid provider is used by these fixtures.

This feature makes no live-provider or cache-hit guarantee. Use provider-reported
usage separately when investigating billing or caching, and do not interpret a
local diagnostic inference as server evidence.
