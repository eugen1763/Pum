# Operational state and live settings

PUM distinguishes desired settings, effective process policy, and request-bound
observations. An observation is not authorization. This design implements #47
on the reviewed #38–#46/#70 foundation.

## Application boundaries

| Setting or capability | Application boundary |
| --- | --- |
| Theme, transcript visibility, animation and other display preferences | Immediate UI projection; session overlay saved as before |
| Writing style and explanation strength | Next accepted prompt's `before_agent_start`; running tool turns and automatic retries retain their prepared instructions |
| Bash output presentation | Next Bash tool call |
| Advisory Check verifier model | Next Check evaluation; deterministic rules remain authoritative |
| Goal retry limit | Next goal-verdict transition using current session settings |
| Explicit main model/thinking selection | Existing pi Settings APIs; the next prepared request uses the selected state, not an already-dispatched request |
| Maximum active workers | Immediate manager admission limit; starting/running workers count, retained inactive records and internal judges/AFK do not; lowering the limit does not stop existing workers |
| Explicit tool-group enablement | Existing successful tool result announces availability for the next model request; canonical role allowlist/order unchanged |
| Check on, stronger sandbox, removed approved roots, hosted-search off | Immediate effective-policy tightening |
| Check off, weaker sandbox, added approved roots, hosted-search on | Pending until **all affected agent runs settle**, then committed together before later work is admitted |

The all-affected-agents-idle relaxation boundary is deliberately conservative and
was explicitly approved by the user in #47. A long-running worker can delay a
requested relaxation. Desired values remain in Settings and the session overlay;
a visible pending notice distinguishes them from effective policy. Retained idle,
completed, failed or stopped records do not themselves block application.

The process-wide coordinator covers main, mutable and readonly workers, internal
judges and AFK delegates, and headless runtimes. Admission reservations include
asynchronous setup/preflight. `agent_end` is **not** settlement: retries and
continuations retain their reservation. True `agent_settled`, failed admission,
completed cancellation and runtime disposal release activity. User shell commands
have a separate reservation because they may outlive the agent turn. Mixed root
changes revoke removed roots immediately and defer only additions. There is no
polling, persistent trust grant, or implicit cancellation of workers.

### Activity ownership and SDK lifecycle ordering

Each public prompt or turn-triggering custom message reserves a distinct identity
before asynchronous preflight. `sendUserMessage` routes through the wrapped public
prompt. Async-local ownership follows the installed SDK's complete run, including
retries and queued post-run continuations. Core `agent.prompt` and `agent.continue`
also hold independent dispatch leases until their own promises finish. This covers
direct core calls reentering from extension hooks without sacrificing the public
owner across retry gaps. The coordinator's `active` field counts reservations,
not sessions or managed-agent capacity; a public run usually holds two while its
core dispatch is active. The capacity setting and manager counts are unchanged.

The installed SDK invokes extension `agent_settled` hooks **before** ordinary
session subscribers. An extension or an earlier subscriber can synchronously
admit a newer run before the older settlement reaches PUM. Settlement therefore
releases only the exact async-scoped owner, never a shared session key or whichever
run happens to be current. Older promise returns, failures and abort completions
likewise release only their captured owners. A predecessor's reentry keeps pending
relaxation blocked; a later subscriber can see a relaxation already committed at
a genuine zero-reservation boundary. Abort invalidates old preflight dispatches;
an abort failure retains already-started work. Even successful SDK abort return
cannot release scoped execution early: its own settlement/core promise must finish.
Disposal refuses reentry before
releasing retained owners. Disposal is lifecycle teardown, not an OS-process kill;
callers remain responsible for stopping work before disposing the SDK session.

The SDK also resets its shared session `isStreaming` flag in an old preflight's
finally, even if a newer underlying agent is streaming. Installed-SDK regressions
assert the underlying agent remains streaming and the exact outstanding leases
still block Check/Sandbox/search relaxation. A further regression exercises SDK
`abort()` returning early because `waitForIdle()` trusts that stale flag: executing
owners still remain reserved until their actual settlement. Activity release does
not trust that shared flag. This does not repair SDK/UI idle reporting itself.
An already-running session bound without
an admission scope has a separate compatibility lease; unscoped events cannot
release scoped owners. The supported runtime paths bind before first admission.
These guarantees rely on the installed SDK preserving async callback scope; a
future detached-event dispatcher requires renewed lifecycle verification.

### Exact-runtime idle consent (#71)

`isRuntimeIdle(session)` is the shared consent predicate, separate from the global
all-affected-runtimes settings boundary. It accepts only an exact, live, fully
activity-bound session with no own public admission, core dispatch or user-shell
reservations, and with **both** SDK session and core `agent.state.isStreaming`
explicitly false. Missing/unbound, binding-in-progress, inaccessible or disposed
runtimes fail closed. Setup has no idle capability before binding; factories expose
controllers only with their exact runtime and App retains session-switch/relocation
and selected-worker starting/running guards. Reservations publish before coordinator
observers run. One idle session is not blocked by an unrelated session's leases.

App MCP connect/approve, LSP connect/check and validation enable use this predicate
in addition to direct-draft-origin and transition checks. Main MCP/LSP controllers
receive the same exact-session callback; validation enable independently checks its
own bound runtime (including a selected mutable worker), so bypassing an App busy
indicator is not sufficient. Preview/digests, native-process policy and controller
identity checks remain separate prerequisites. Direct revoke/disconnect, LSP stop
and cancellation, and validation disable remain available during active work.

Installed-SDK tests reproduce cancelled old preflight unwinding after a new custom
run starts: the old finally sets `session.isStreaming=false` and old settlement
clears App's busy mirror, while the core remains streaming with two owned leases.
Real MCP/LSP connect and validation enable refuse. A rendered App test runs this
same real SDK/controller scenario and verifies all five protected commands stop
before controller dispatch; active revocation still works and legitimate idle
consent reaches both sentinel process spawns after actual newer settlement.
Sentinel spawns establish admission, not native confinement or real-server
compatibility. Unit tests separately cover each owner despite false flags, exact
runtime isolation, observer reentry and disposal. This is a synchronous admission
check, not a lock against future work, cross-process coordination, or a fix for
arbitrary integrations bypassing the bound SDK entrypoints. Reverify owner/flag
contracts on SDK upgrades; do not substitute App busy or a global reservation count.

### Checked-call revocation

A monotonic security epoch invalidates asynchronous approvals on effective
revocation, not on a merely pending desired relaxation. Check hooks and structured
trigger/shell checks reject late SAFE results after tightening. The bound public
`beforeToolCall` chain also checks its epoch after all asynchronous hooks. Core
file/process tools check that recorded approval again at their execute entry,
because pi prepares every parallel call before it executes any of them. An
unexecuted preflight is not already-dispatched work: stale permission must not
execute. Authority binds the exact tool object and validated argument object,
with the call ID and security epoch checked only as record fields. IDs supplied
by the model need not be unique. The installed SDK runs native `prepareArguments`
and schema validation first, then passes the same validated object to preflight
and execute; this wrapper does not replace either transformation. A duplicate
same-tool or cross-tool ID cannot delete or overwrite another call's approval.
Wrapped execution fails closed for missing, mismatched, consumed or stale
approval. Execution consumes only its own record; result IDs revoke nothing.
Abandoned records expire at `agent_end` (including before retry), final settlement
and disposal; a late preflight cannot restore an expired generation. This cleanup
does not release the coordinator's activity reservation on `agent_end`.
Synthetic validation uses the same bound preflight/execute route and exact args
object. Standalone unbound tools and direct user `executeBash` retain their
existing paths; direct callers of a wrapped tool must use its bound preflight.
This is not a guard against arbitrary extension code, mutation through retained
original tool functions, or OS work already admitted at the execute boundary.

Settings/session replacement reapplies the target's desired settings through the
same coordinator. Additional roots still pass the existing direct-user path
validation and process-local relocation rules. This mechanism does not grant MCP,
LSP, validation, checkpoint or draft-command authority.

## Operational notices

Capacity and effective Check policy no longer rewrite the system prefix. Static
coordination and conditional batching rules remain there. `pum.subagent_capacity`
and `pum.check_policy` observations append at complete tool-call/result boundaries
in a runtime-private context projection. `pum.search_state` describes the prepared
request's role-effective hosted-search state. Each notice explicitly supersedes
earlier notices of its own kind and says that live enforcement remains decisive.

Each observation is size-bounded (16 KiB). There is no raw settings serialization,
secret data, timestamp churn or changing tool description. Capacity coalesces
counts to available/full plus the configured limit. Identical observations and
unchanged retries add nothing. Every retained notice stays at its original source
message boundary, including when upstream memory adds an observation. An
incomplete tool block defers insertion rather than splitting calls/results.

No operational projection enters the durable transcript or a companion file.
Explicit tool results retain their normal persistence. Runtime replacement,
non-append branch changes, compaction and explicit `new_context` start a fresh
projection. This consolidates current observations, not a summary. The existing
context meter observes the complete projection and charges the retained chain.
There is no hidden pruning, automatic rollover, or claim of provider cache hits.

Main and mutable workers receive capacity observations. Readonly workers,
headless main, judges and AFK have no delegation-capacity invitation. Effective
Check observations are not permission for a restricted role to use tools it does
not own. Role-specific tool schemas and execution guards remain authoritative.

## Hosted search and revocation

Search remains bound to the exact trusted session, role and private request hook.
Only main and mutable-worker roles qualify; readonly, judge, AFK, unknown,
unbound and direct verifier requests remain denied. After the inner context hook
chain completes, the binding snapshots effective search state and projects the
matching notice before granting that request a capability. Unsupported direct
stream calls without a prepared context fail closed.

The final payload hook runs extension hooks first, then checks the request grant,
live role-bound lifetime, current enabled flag and a monotonic disable epoch.
Disabling search invalidates even a prepared request. Each bound stream invocation
has a private AbortController composed with its parent signal. Only invocations
that actually emit a search-bearing payload enter the revocation registry. Disable
aborts those controllers synchronously, invalidating pending handshakes, SDK retry
waits and SSE fetches; re-enable cannot revive them. Disposal also aborts outstanding
bound requests. Success, error, abort and disposal remove registry entries and parent
listeners; search-free invocations are not cancelled merely by a search toggle.
A fresh request needs a fresh coherent observation. Enabling globally cannot bypass
the role allowlist or inject search through an unrelated callback.

This additionally depends on an explicitly tested installed-SDK transport seam.
pi 0.85 invokes `onPayload` once, then reuses that body for WebSocket retries and
SSE fallback/retries. Abort rejects its pending handshake and suppresses retries,
but its cached socket acquisition and open-to-send microtask gap have no final
abort check. PUM therefore adds an enumerable, request-owned body `toJSON` fence.
The SDK's shallow full/delta body copies retain the method, while JSON omits the
function. Only the actual `response.create` envelope is fenced, inside the SDK's
socket-release `try/finally`. It first checks revocation, invokes the preserved
root serializer once, then materializes its complete JSON output through a local
holder serializer and parses it into inert JSON data. Bun's source-aware parser
and callback-free raw-JSON primitive records preserve even oversized raw integers,
exponent spellings and escaped raw strings byte-for-byte. This preserves the native
rule that a root serializer's returned object is traversed, not root-converted
again. Nested serializers/getters run with their ordinary keys, order and cycle
handling; recursive encounters delegate without recursively materializing.
A **second check after all conversion** catches synchronous disable/re-enable,
parent abort or disposal from any root/nested serializer or getter. The SDK then
serializes only inert data before `socket.send`, with no extension callback left
to run after the check. Materialization is ephemeral, never persisted or logged.
Revocation throws a generic abort error without raw content. A tools-array fence would
also throw during earlier cached-body comparisons, outside that cleanup region,
so is deliberately not used. No global socket/prototype patch grants authority.
The wire JSON and tool order stay unchanged, extension-returned fields and any
existing serialization method remain, and auto/cached WebSocket transport is
preserved. Historical continuation comparisons serialize ordinarily without
reviving a completed invocation. SSE serializes earlier but checks and passes
the composed signal on every fetch. An SDK upgrade that deep-clones bodies,
pre-serializes WebSocket frames, ignores abort or changes retry lifetime requires revalidation;
this is not a general transport contract for arbitrary custom providers/hooks.

`tests/web-search-transport.test.ts` uses the real installed Codex provider and a
local HTTP/WebSocket server, with no provider credentials or paid requests. It
covers held HTTP Upgrade, the cached-acquire microtask gap, actual connection-limit
retry, fallback and SSE-only admission/retry with the hook called only once,
parent abort/disposal, disable/re-enable, successful/error registry cleanup,
search-free requests, and full/delta caching and socket recovery across state changes.
Root and nested serializer revocations cover both fresh and reused sockets for
all four actions (disable, disable/re-enable, parent abort, disposal). Positive
controls cover replacement roots, nested keys/getters, primitive/array roots,
conversion counts, exact raw-JSON primitive bytes, native cycle/BigInt failures
and unchanged SDK SSE fallback,
plus diagnostic hashes and tool order. This extra encode/parse pass costs one
frame-sized temporary representation at send; it does not replace SDK cache
comparisons or fix arbitrary extension exceptions in those earlier comparisons.

A revocation cannot retract a provider request already dispatched. Likewise,
changing local policy cannot retroactively sandbox an OS process already admitted
under earlier policy. The execution guard is a check-time boundary at tool entry,
not an atomic operating-system transaction: it cannot undo work after entry or
remove the existing path-check/syscall race inside a tool. Immediate tightening governs subsequent admissions and
not-yet-dispatched hosted-search payloads; it is not a promise of retroactive
termination or backend cancellation. Native readonly execution remains fail-closed
regardless of the desired/global Check or sandbox settings.

## Validation and limits

Focused unit and installed-SDK tests exercise append-only projection, capacity
transitions, restricted-role exclusions, policy batching, search dispatch/retry
races, lifecycle reservations, UI pending state, memory composition and context
budgeting. Gated verifier tests cover ordinary and synthetic revocation, and an
installed-SDK parallel batch with native local Bash verifies that an earlier
prepared command does not create its output after a sibling crosses tightening. Exact commands and results are recorded in #47 before integration.
These tests use local fake providers and do not establish paid-provider cache
hits, real hosted-request cancellation, cross-process coordination, or new native
sandbox guarantees. The coordinator is process-local, matching PUM's existing
live settings policy. No SDK dependency or protocol version is changed.
