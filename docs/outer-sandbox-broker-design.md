# Outer-sandbox credential broker: design and blocking prerequisites (#67)

Status: **deferred by user decision on September 20, 2026; no broker is implemented**.
The user chose to release other work without an unsafe broker approximation. This
document records the blocker and proposed requirements, not implementation approval.
It does not change the security guarantees of `pum s` or `pum sr`. The existing MVP still
mounts PUM credentials. Do not close #67, advertise credential isolation, or treat
this document as approval to change the outer-sandbox trust boundary.

Issue #67 belongs to roadmap #37. Both issue bodies were inspected through `gh`.
The implementation baseline reviewed here is `c3efa3d` (pi SDK 0.85.0). The design
was recorded before implementation, as required by the issue.

## Concrete blocker and decision required

The current outer launcher starts the **entire PUM application** inside one
claudebox sandbox. Trusted provider/runtime code and arbitrary tool subprocesses
have no separately established OS security principal. The launcher protocol used
by PUM carries mount paths, environment values and an executable/argv, not an
exclusive authenticated runtime channel or a runtime/tool separation primitive.
A secret in an environment variable, file, command argument, loopback request,
or shared socket would merely replace the provider credential with another
usable credential. An HMAC or challenge/response does not fix this when tools
can obtain the signing key. A caller-supplied role or PID is not authentication.

This cannot be safely fixed by replacing the `auth.json` mount with a tokenized
HTTP proxy. Nor is `--pass-fd` alone a sufficient answer: transport availability
and exclusive ownership by an isolated trusted process are different properties.
The application must prevent descriptor inheritance, process inspection, memory
access, and modification of code/configuration later loaded by the trusted runtime.

**Decision for any future resumption:** approve one of these architectural changes:

1. **Host trusted runtime, sandbox all untrusted execution (preferred direction).**
   Move the TUI/agent loop and provider authority to a trusted host supervisor;
   execute tool work in a credential-free sandbox through a bounded tool protocol.
   This changes the existing promise that the whole application runs inside the
   outer sandbox. Every execution path, not just Bash, must be routed or refused.
   A host broker can then accept only the trusted runtime's private connection.
2. **Keep the runtime sandboxed, introduce a distinct trusted runtime compartment.**
   Extend claudebox with an explicitly negotiated secure channel and OS-enforced
   separation between the trusted runtime and all tool code. This needs changes
   outside this repository plus native integration evidence. Preserve the outer
   application confinement promise, but do not assume in-container UID checks or
   a donated FD provide the separation without a tested process/capability policy.

Both require explicit treatment of extensions: code loaded into the trusted
runtime has that runtime's authority. Repository-controlled extensions cannot be
both untrusted and in-process. Disable them in broker mode or obtain an explicit
trusted-code decision with immutable code provenance. No silent compatibility
fallback is acceptable. Until the decision is made, do not change working sandbox
commands into a different architecture or claim the acceptance criteria are met.

## Inspected interfaces and consequences

| Interface | Current behavior | Broker consequence |
| --- | --- | --- |
| `src/outer-sandbox-launch.ts`, `buildPumOuterSandboxPlan` | Adds the entire `agentDir:rw`, runtime executable directory and package root; sets child `PUM_DIR` | Remove all credential-bearing mounts, including exposure through an ancestor project/extra/runtime mount; merely omitting the direct config mount is insufficient |
| `src/outer-sandbox.ts`, `buildOuterSandboxLaunchPlan` | Emits `--no-mount-home`, `--cwd`, `--mount`, `--env`, `--exec` | No represented authenticated IPC or trusted/untrusted process separation |
| `src/outer-sandbox-process.ts` | Accepts exactly protocol 1 and `ok` probe responses; spawns with inherited stdio | Neither response attests to a secure broker capability; no dedicated FD is forwarded by PUM |
| `src/main.tsx` | Creates `ModelRuntime` with `AUTH_PATH`/`MODELS_PATH` inside the child; sets inner sandbox mode to `off` for outer launches | Tools and provider authority share the outer compartment; toggling Check does not supply a new OS boundary |
| `src/headless.ts` | Creates its own credential-backed runtime; outer headless is not supported | Do not accidentally create a direct-auth fallback or silently extend launch modes |
| Installed `ModelRuntime` (`dist/core/model-runtime.d.ts`) | Owns credential store, auth resolution, login/logout, provider registration, model discovery and stream/complete/deferred calls | A broker is not just a replacement `fetch`; raw `getAuth`/credentials must never be remotely exposed |
| `src/web-search.ts` and bound request policy | Wrap provider calls; support provider-native streaming, including WebSocket state | Preserve exact requesting-runtime role, search revocation, retries and continuation ownership; do not force SSE to simplify proxying |
| Main/worker/judge/AFK/verifier runtimes | Share model infrastructure with distinct role authority | Bind each request to a host-created runtime record, never a client-asserted role |
| File tools, Bash, direct-user shell, managed shells, triggers, validation, Git/worktree operations, MCP/LSP and SDK resources/extensions | Different execution and lifecycle paths, not one subprocess entrypoint | Inventory and route or disable every path before moving any currently sandboxed work to the host |

The SDK permits custom `CredentialStore` and native providers, but those are
integration seams, not isolation primitives. Provider wrappers must preserve
methods and must not allow request-level endpoints, headers or API-key overrides
to cross the broker boundary as authority.

## Threat model

Protect API keys, OAuth refresh/access tokens, provider session material, custom
provider secrets, and the authority to spend quota or mutate provider accounts.
Also protect the broker's trusted endpoint configuration, role grants and login
state from modification by tools.

Assume an attacker controls repository contents, model tool arguments, shell
commands and their descendant processes, MCP/LSP output, and bytes returned by
external services. Assume Check mode can be Off. Attackers may enumerate any
visible environment, filesystem, sockets and process metadata; attempt process
inspection and FD theft; spawn alternate clients; replay captured messages;
modify project files concurrently; and disconnect or flood channels. A valid
provider request generated by the trusted runtime from malicious prompt content
is not the same as a tool authenticating directly to the broker.

Trust the host OS and user, installed immutable PUM/runtime code, the launcher and
its enforcement implementation, and explicitly approved host provider configuration.
Do not trust an environment marker as proof of sandbox identity. Host compromise,
kernel/runtime escape, malicious explicitly trusted in-process code and hardware
side channels are outside the claim. Prompt injection, inference spending within
an authorized runtime grant, and exfiltration of ordinary project data over an
otherwise allowed tool network are not solved by hiding credentials.

## Proposed least-privilege protocol (not implemented)

### Transport and authentication

Use a launcher-created private connected channel with OS-enforced exclusive
ownership. No network listener, discoverable shared socket path, ambient bearer
secret or secret on argv/environment. Possession of an exclusive channel is a
capability only after the compartment boundary is proven. A Linux implementation
may use a socketpair; actual claudebox/runsc support must be negotiated and tested.
The guest must not be able to acquire the host endpoint or reopen the runtime
endpoint through process inspection. All untrusted descendants must start with
only explicitly permitted descriptors and without access to runtime memory.

The broker binds the connection to one fresh launch generation and a host-owned
runtime registry. The host assigns runtime IDs, parent/role relationships and
policy epochs before requests are admitted. Messages cannot register a new role
or rebind themselves to another session. Separate logical runtime streams can be
multiplexed only by the trusted supervisor, not by untrusted tools.

An initial bounded handshake negotiates a fixed protocol version and supported
operations. Authentication is the verified launch/channel binding, not the JSON
handshake fields. Reject unsupported versions/capabilities before session startup
or mounting state; do not fall back to protocol-1 credential mounts.

### Frames and request authority

Proposed frames use a length-prefixed strict data encoding, with a hard frame cap,
aggregate request cap, bounded stream queues/concurrency and read/idle deadlines.
Numeric limits must be fixed and tested before protocol implementation; large
contexts need explicit bounded chunking, not unbounded JSON buffering. Each frame
carries the launch generation, host-issued runtime handle, monotonically increasing
sequence, request ID, operation and bounded payload. Unknown fields/operations,
malformed encodings, duplicate IDs and stale/out-of-order sequences fail closed.

Allowed operations are a sanitized model catalog, `infer.start`, `infer.cancel`,
and bounded response/event delivery. Any future deferred fetch/cancel must bind
the deferred handle to its originating runtime and generation. No generic HTTP
proxy, arbitrary URL, credential retrieval, provider registration, filesystem
operation, shell operation, account administration, login or logout API exists on
the model channel. Login/settings changes remain host UI operations with direct
user authority, not inference RPCs.

For inference, the host resolves provider/model IDs against its own catalog and
endpoint configuration, applies exact role/search authority and resource limits,
and attaches credentials only immediately before provider dispatch. The client
cannot override authorization headers, base URLs, proxy settings or credential
environment. Custom endpoints require explicit host-side configuration; redirects
must not forward credentials to an unauthorized origin. Disabled/unsupported
providers fail explicitly rather than switching to a generic passthrough.

The broker exposes normalized SDK events, not raw upstream headers, auth objects
or transport errors. Provider WebSocket/delta caches remain host-owned and keyed
to the exact authorized runtime; a client cannot name another runtime's
`previous_response_id`. Credentials and authenticated URLs never enter child
state, tool output, session entries or diagnostics.

### Replay, cancellation and failure

- Sequence and request-ID validation happens before dispatch, including concurrent
  duplicates. Replaying accepted frames never starts another billable request.
- A new connection gets a fresh launch generation. No old channel resumption,
  caller-provided generation reuse or automatic replay of ambiguous requests.
- Cancellation is scoped to a request owned by that live runtime. It cannot cancel
  another session. The broker aborts its upstream work and releases bounded queues.
- EOF, broker death, malformed protocol, authentication failure, timeout or policy
  revocation terminates the affected capability. Stop admitting new requests and
  cancel outstanding work. Surface a bounded safe error; do not retry through
  direct credentials or another transport. Upstream cancellation cannot guarantee
  reversal of work/billing already accepted by the provider.
- Supervisor exit tears down broker and sandbox children. Endpoint handles are
  closed on every spawn/handshake failure. No daemon, persistent secret or orphan
  listener remains. Restart requires a fresh authorized launch.
- Errors use stable codes and generic public text. Never stringify arbitrary SDK
  exceptions or echo invalid frames. Test secrets in nested causes, request URLs,
  response headers, split streamed chunks and crash paths. Do not rely solely on
  regex redaction of known key formats; allowlisted output is the first boundary.

## State and mount migration

A broker-enabled child receives no host config directory, `auth.json`, raw
`models.json`, secret environment, OAuth cache or host credential-bearing runtime
path. A sanitized catalog is generated structurally from allowlisted fields.
Ancestors, overlaps, alternate mounts and project-local `PUM_DIR` must be checked;
configuration merely stored under another visible path is still exposed.

Prefer host-owned sessions, settings and login under the host-runtime design.
If sessions remain child-side, use a separate credential-free state store with a
documented persistence/synchronization protocol. Never copy the whole PUM config
and then delete a few known secret fields. User-submitted API keys must not traverse
the untrusted tool compartment. Login inside the current child therefore needs an
explicit host UI handoff or an unsupported-operation error, not a secret relay
that is accessible to tools.

Host-runtime deployment must also reject a trusted application/code location
writable through project/extra tool mounts. Read-only mounting of the same bytes
into one compartment does not prevent a different writable alias changing them.
Enforce protection for configuration, executable/package code and future loads,
not only the initial connection setup.

## Platforms and unsupported behavior

No secure broker transport is currently supported by this repository. Linux and
Linux-inside-WSL-2 are candidates, not validated guarantees. PUM's current protocol-1
probe is insufficient. A future secure mode must require an explicit capability
probe plus end-to-end enforcement tests on each supported launcher build.
Native Windows and macOS have no outer-broker implementation; refuse secure mode
before auth/state access, with actionable platform/setup guidance. Do not reuse
inner MXC/Bubblewrap availability as evidence of outer-channel isolation.

Fail-closed requirements above describe the proposed implementation. **They do not
mean this design-only change disables or fixes the existing protocol-1 MVP.**
Whether to disable that MVP pending implementation is a separate user-visible
compatibility decision, not an implicit side effect of writing this design.

## Required validation before implementation can be accepted

| Test | Required evidence |
| --- | --- |
| Tool impersonation | Real untrusted processes cannot find/open broker endpoints, inherit/steal its FD, read runtime memory/environment, or authenticate by guessed role/PID/session/token; valid runtime request still succeeds |
| Code/config substitution | A tool cannot alter trusted runtime/provider/extension bytes or host configuration through overlapping/writable mounts and then obtain authority |
| Replay | Concurrent duplicate, reordered and old-generation frames dispatch upstream zero additional times; disconnect/reconnect cannot replay ambiguous accepted work |
| Disconnection | EOF/death/timeout before handshake and during streaming cancels work, cleans process trees/FDs, creates no orphan listener and never falls back to direct auth |
| Least privilege | No arbitrary endpoint/header/auth API; denied role/search grants remain denied across async hooks, retries, disposal and runtime replacement |
| Redaction | Canary secrets absent from child mounts/environment/argv, session JSONL, UI labels, diagnostics, errors and streamed responses; include upstream echo and malformed messages |
| Resource bounds | Oversize/slow/fragmented frames, stream flooding and concurrent requests cannot create unbounded queues or orphan upstream work |
| Platforms | Native Linux and WSL-2 real launcher tests; explicit pre-auth rejection on unsupported OS/runtime/protocol; mock-only tests are not evidence of process isolation |
| Compatibility | Login, custom providers, main/worker/judge/verifier roles, cancellation, hosted search and WebSocket/delta transport retain their documented behavior or fail explicitly |

Pure framing/unit tests can establish protocol validation, but cannot demonstrate
exclusive process identity or secret isolation. A mock broker accepting a token
would conceal the blocker rather than test it. No such implementation is added.

## Evidence and validation status

Current repository tests cover protocol-1 argument construction, launch mounts,
probe and process lifecycle. They intentionally describe the existing MVP, not
broker authentication. Validation of this documentation-only change:

- `bun test tests/agent-guidance.test.ts tests/outer-sandbox.test.ts tests/outer-sandbox-launch.test.ts tests/outer-sandbox-process.test.ts`
  — 26 passed, 0 failed, 7,039 assertions.
- `bun run typecheck` — passed.
- `git diff --check` — passed.

No live `claudebox` executable is available in the review environment. Native
impersonation, credential-isolation, replay, disconnect and platform acceptance
testing is therefore **not completed**. The passing baseline tests are not broker
tests, and no mock-only security implementation or regression is claimed.

Primary documentation consulted September 20, 2026:

- gVisor **Security Model**, `https://gvisor.dev/docs/architecture_guide/security/`:
  applications can access mapped files and permitted network connections. Outer
  sandboxing alone is not a separate credential boundary between its applications.
- gVisor **FUSE / External FUSE Server**,
  `https://gvisor.dev/docs/user_guide/fuse/`: documents socketpair donation using
  `runsc --pass-fd=HOST_FD:GUEST_FD`. This establishes a possible transport primitive,
  not claudebox protocol support or an exclusive trusted-runtime identity.
- Installed official pi SDK 0.85.0 declarations/source under
  `@earendil-works/pi-coding-agent/dist/core/model-runtime.*`, and PUM integration
  files listed above. Their existence establishes integration points only.

Implementation is deferred. It should resume only after the architectural decision
and prerequisite ownership are recorded. Independent review must verify the OS boundary first,
then provider least privilege, then compatibility; #67 remains open until those
requirements are implemented, tested and integrated.
