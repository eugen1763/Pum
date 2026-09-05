# MCP integration (#45)

PUM supports a deliberately narrow **2025-11-25 tools-only stdio subset**, not
latest-version or full MCP compatibility. Main TUI only. Configuration is inert;
launch, resume, tool-group reveal and repository instructions never start a server
or grant approval. The implementation is subject to independent integration review;
no installed third-party server or successful native interoperability run is claimed.

## Accepted scope and residual risk

On September 5, 2026 the user approved **readonly live-project access** after the
explicit explanation that a server can read project secrets and return them to the
model (issue comment 5552672827; revised design 5552682876). This supersedes the
earlier blocked checkpoint. It is not approval of an individual server or toolset.

Readonly and networkless do **not** imply confidentiality. The approved executable
and present/future project code are trusted to run. Bounded sensitive-name masks
are defense in depth only: unknown-name secrets, aliases/hardlinks and new files
can still be exposed to the server and then through its tool results. This is not
a sanitized snapshot or a guarantee against prompt injection. Path checks and
scans are check-time measures, not atomic filesystem isolation from other writers.
The native sandbox does not limit CPU or total process memory consumption.

## Direct-user workflow

An exact-cwd `.pum/mcp.json` proposes servers, for example:

```json
{
  "version": 1,
  "servers": [
    { "name": "example", "executable": "/absolute/path/to/program", "args": ["literal-argument"] }
  ]
}
```

This is a format example, not an installation or activation instruction. Never
put credentials in the file or arguments. No installers, remote URLs, environment
configuration or automatic startup fields are accepted.

1. Enter `/mcp` or `/mcp preview` directly in the main TUI. It shows complete literal
   argv, exact live-project scope, residual risk and the raw-byte proposal SHA-256.
2. While idle, enter `/mcp connect <server> <proposal-sha256>`. This authorizes only
   this runtime's native process launch and discovery, not any tool execution.
3. Read the returned **untrusted** tool names, descriptions and complete accepted
   schemas. Enter `/mcp approve <server> <toolset-sha256>` while idle to approve that
   exact discovered set. The toolset hash includes server identity, proposal hash
   and all accepted metadata/schema bytes.
4. The main model can reveal the optional `MCP` group through `enable_tools`.
   PUM-owned static `mcp_list` and `mcp_call` bridge schemas expose only approved
   servers. `mcp_list` lists names, or returns one selected tool's bounded schema.
   Server text never becomes a tool definition or system instruction.
5. `/mcp status` reports runtime state. `/mcp revoke [server]` (also `disconnect`)
   withdraws authority and closes processes, including during discovery/streaming.

Draft origin is retained independently of cache row indices. Cached/history/queued
and programmatically restored drafts cannot invoke **any** MCP command, including
preview/status/revoke/disconnect. Edits, completion, no-op history navigation and
view restoration cannot turn them into direct input. Clear a nonempty draft with
Ctrl+C and type anew. The same conservative policy protects `/validation` and
`/checkpoint`; see `docs/draft-command-provenance.md` for the boundary and tests.

These commands are direct App operations, **not SDK extension commands**. Model
input, cache/stash execution, server annotations, `enable_tools`, Check verifier,
replayed transcript and extensions have no consent route. Workers (mutable too),
readonly agents, judges, AFK delegates and headless runtimes have no MCP tools or
server access. A call checks the exact bound SessionManager object, session ID,
cwd and live runtime, not a model-supplied role or identity.

Each newly created/replaced/resumed runtime owns a new controller with no approval.
Disposal, user cancellation, protocol failure, deadline, tool-list-change notification,
missing/invalid/changed proposal, or stale discovery/call revokes authority. File
watchers monitor the project, proposal directory and proposal file; synchronous
revalidation also runs at consent/call boundaries and after asynchronous results.
Watch failures fail closed. Relevant renames revoke even when replacement bytes are
identical, avoiding watchers stranded on old inodes. File and ancestor device/inode
identities are also bound at preview and rechecked synchronously at call/approval
boundaries. Transient changed-then-restored bytes between observations
cannot be guaranteed detectable; no filesystem watcher is an atomic history.
No retry, rediscovery, reconnection or trust restoration is automatic. Consent and
preview reports are runtime-only; ordinary explicit MCP tool input/output retains
the normal transcript contract.

## Native boundary

`src/mcp-process.ts` requires Linux and a successful fixed-path Bubblewrap probe,
regardless of Check or Sandbox settings. Missing or unusable native enforcement
fails closed; there is no unsandboxed fallback. General Bash sandbox policy is
unchanged.

- Only the exact cwd project is shared readonly; additional Check roots are not
  inherited. Files outside that scope remain unavailable except minimal readonly
  system runtime mounts (`/usr`, `/bin`, `/sbin`, `/lib`, `/lib64`, where present)
  and the exact canonical executable **file**, never its containing directory.
- No host `/etc`, home, ambient environment, credentials, OAuth or network access.
  The environment contains only fixed PATH, HOME, TMPDIR and LANG values. PUM's
  custom/default configuration boundary is denied even when inside a visible root.
  MCP refuses configuration boundaries overlapping any system mount source in
  **either containment direction**, checking supplied and canonical spellings.
  For example, `/usr/lib/pum` is refused rather than masked only there while
  the independent `/lib` bind could still expose `/lib/pum`. The same rule covers
  `/bin`, `/sbin` and `/lib64` aliases. This protected PUM configuration is **not**
  part of the accepted unknown-project-secret residual risk.
  Configuration must be an existing directory with no symbolic-link components;
  malformed, missing or non-directory boundaries fail closed even outside visible
  mounts. Config and ancestor device/inode identities are compared before and
  after policy construction to reject observed replacement. These are check-time
  checks, not an atomic defense against replacement after the final check.
  Existing default-layout and custom configuration outside system sources remain
  supported; an in-project configuration is still masked. General Bash behavior
  is unchanged. Deterministic tests cover merged-`/usr` aliases, containment,
  malformed/missing/linked boundaries and mid-build directory/ancestor replacement.
  They do not substitute for the probe-gated harmless-sentinel native fixture;
  Bubblewrap is absent on the September 5, 2026 review host, so that fixture skips.
- Private PID/IPC/UTS/user/network namespaces, dropped capabilities, parent/process
  cleanup and private writable temporary scratch use the existing Linux backend.
  Persistent stdin is opt-in; ordinary Bash/shell stdin semantics are unchanged.
- A recursive project scan masks known sensitive names without following symlinks.
  Sensitive symlinks, sockets, FIFOs/devices, invalid scope and scan failures refuse
  startup. Ordinary symlink aliases are a disclosed limitation, not a secret filter.
- Scan bounds: 50,000 entries, depth 32, 2,048 masks, 256 KiB combined mask paths and
  a five-second checked deadline. Excessive repositories fail closed, not partially
  masked. Mask/race checks do not prevent arbitrary or concurrently added secrets.
- Nonstandard executables needing neighboring libraries/configuration, authenticated
  servers and servers requiring `/etc` or network may fail. This MVP does not grant
  broader mounts to make them work.

## Bounded proposal and protocol

`src/mcp-config.ts` accepts at most 16 KiB UTF-8, four uniquely named servers,
lowercase ASCII server identifiers (1–32 characters), absolute POSIX executable
paths (4096 bytes), and 16 literal arguments (1024 bytes each). Controls and bidi
formatting are rejected. Unknown fields fail closed. Reads use bounded nonblocking
regular-file descriptors, single-link checks and before/after file/ancestor identity
checks; symlink components are rejected. These remain check-time safeguards.

`src/mcp-protocol.ts` uses newline-delimited UTF-8 JSON-RPC, exact protocol-version
checking, empty client capabilities, tool listing and calls. It never adopts
initialize instructions, tool annotations as authority, resources/prompts/roots,
sampling, elicitation, tasks, images, URI following or server-requested credentials.
Unsupported requests get a bounded method-not-found response; ping is supported.
Only text result blocks are returned, with an explicit untrusted-source label;
other blocks and structured content are omitted with notice. Raw stderr, server
errors and OS errors are not forwarded.

Limits: 256 KiB frames, 16 MiB lifetime stdout, discovery 32 tools/four pages/256 KiB,
16 KiB schemas and arguments, 16 KiB/200-line text results, schema depth eight and
256 schema nodes. The narrow JSON Schema subset rejects unknown keywords, refs,
regex and code generation. JSON data is validated again at execution because SDK
extension hooks can mutate arguments after initial schema validation. Discovery
uses absolute 10-second deadlines; calls 30 seconds, at most four in flight.
Persistent stdin has bounded queued writes and write deadlines. Cancellation closes
the process after best-effort protocol cancellation; initialize is never cancelled
with `notifications/cancelled`. Late results cannot restore authority.

## Primary references

Official pinned protocol sources inspected:

- https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle
- https://modelcontextprotocol.io/specification/2025-11-25/server/tools
- https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation
- https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
- https://modelcontextprotocol.io/docs/2025-11-25/tutorials/security/security_best_practices

Installed `@earendil-works/pi-coding-agent` 0.85.0 `docs/sdk.md`, relevant
`docs/extensions.md` contracts and implementation were inspected for registration,
active-tool order, exact session context, input mutation, error signaling and
explicit disposal. The bridge throws bounded labeled tool failures because the
installed SDK ignores a returned `isError` property.

## Validation and limitations

September 5, 2026 integration validation:

```sh
bun test tests/mcp-config.test.ts tests/mcp-protocol.test.ts tests/mcp-process.test.ts tests/mcp.test.ts tests/mcp-authority-audit.test.ts tests/mcp-ui.test.tsx tests/mcp-sdk.test.ts tests/sandbox tests/sandbox-policy.test.ts tests/shells/process.test.ts tests/tool-groups.test.ts tests/tool-groups-sdk.test.ts tests/commands.test.ts tests/help-popup.test.tsx tests/web-search.test.ts tests/memory-context.test.ts tests/transcript-history.test.ts tests/file-checkpoints.test.ts tests/project-validation.test.ts
bun run typecheck
git diff --check
```

**304 passed, 3 skipped, 0 failed; 2,127 assertions across 22 files.** Typecheck
and diff checks passed. Skips: actual native MCP fixture (Bubblewrap absent),
existing generic native enforcement fixture, and Windows MXC probe on Linux.
Independent authority review found and regressed three corrected issues: cached
consent routing, matching-ID but foreign SessionManager calls, and identical-byte
proposal-directory replacement stranding old watchers. The final audit suite includes
synchronous replacement-before-call and config-change-after-response races.

Fixtures cover parser/protocol hostility, native policy argv, controller consent,
owner binding, cancellation, configuration changes, role/group permissions and
TUI command routing. Protocol/controller fixtures use injected literal transports;
they are not native enforcement evidence. A disposable actual Bubblewrap fixture
runs only where native enforcement is available, without installing server software.

On this host Bubblewrap was absent during the initial implementation. Native
fixtures are skipped and that absence is a material validation limitation. No
paid-provider test, installed third-party interoperability, Windows MCP execution,
headless access, remote HTTP/SSE/OAuth, authenticated/writable/networked servers,
full-protocol compatibility or confidentiality proof is claimed. Main review and
its validation are required before committing or closing #45; no release is implied.
