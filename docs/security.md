# Safety

[← Back to the README](../README.md)

> [!WARNING]
> PUM can read, write, and delete files. Check mode adds deterministic policy
> checks, and supported hosts can enforce native Bash isolation. The file-tool
> sandbox is a process-local path guard, not complete operating-system
> isolation. Review these safeguards before using untrusted workspaces.

PUM has three separate boundaries: a path guard around the file tools, Check
mode's deterministic policy, and a native OS sandbox for the processes the model
starts. They are independent, and none of them replaces the others.

## Filesystem sandbox

The process-local filesystem sandbox validates `read`, `write`, `edit`, and
`apply_patch` before execution.

- Project paths and `/check-path` roots are allowed.
- Credential-sensitive paths are blocked.
- Symbolic links and junctions in tool paths are blocked.
- `apply_patch` stays project-local and keeps its atomic validation.

This boundary does not isolate `bash`, package scripts, extensions, or trigger
processes from the operating system. Use a container, VM, or policy-controlled
sandbox for stronger isolation.

## Check mode

Select Check mode in `Ctrl+P` — **Off** or **On**. It applies to `bash`, `edit`,
`apply_patch`, external-trigger processes, and managed shells.

- **Off:** checked tools run without the deterministic policy or the advisory verifier. This is the default.
- **On:** the deterministic policy runs first, then an advisory verifier reviews the complete proposal.

On allows ordinary complete project-local calls, explicit on-mode external reads
(read-only), and project-local edits. It accepts one direct `npm pack` only when
lifecycle scripts are disabled, an explicit cache stays in an approved root,
output stays in an approved root, and any package operand is one exact registry
version. It accepts one direct `npm install` of one exact registry version only
with explicit `--ignore-scripts`, an approved `--prefix`, and an approved
`--cache`. File, Git, URL, tag, range, composed, general install, and
global-install forms stay blocked.

On hard-blocks external writes, location changes, execution operands, ambiguous
path access, escaping links or junctions, credential access, privilege
escalation, persistence, remote-script execution, destructive Git operations,
and broad deletion. These cannot be overridden and never open a popup — there is
no approval popup and no approval store anywhere in Check mode.

On blocks an explicit verifier verdict of `UNSAFE`. An unclear, unavailable,
failed, or timed-out review does not block a fully validated call. The one
exception is a deterministic match for a direct main-agent `npm publish` or
`npm dist-tag add ... latest`, which On allows outright; managed subagents
cannot use it.

For `edit` and `apply_patch`, PUM validates the complete proposed change before
any mutation. Review data includes the unified diff, changed paths, line counts,
sensitivity flags, project containment, and full-content SHA-256. Invalid,
stale, malformed, escaping, or incompletely analyzed input blocks the call.
Verifier prompts stay bounded: an oversized review sends complete validation
metadata, counts, findings, and digests rather than a raw prefix pretending to
be the whole thing.

### Additional roots

`/check-path list | add <directory> | remove <directory> | clear` manages up to
16 additional directory roots for the current launch project. The filesystem
sandbox applies them to `read`, `write`, and `edit`; Bash, edit, and
external-trigger checks use them too; `apply_patch` stays project-local. Added
roots are canonicalized and remain subject to every hard block.

## Native sandbox

The **Sandbox** setting has three modes:

- **Auto:** enforce the platform sandbox when available. If probing fails, keep deterministic Check mode and show one process-local warning that never enters session context.
- **Require:** block checked calls unless native enforcement is available.
- **Off:** do not sandbox. Check mode policy is unchanged.

Check mode **Off** always uses pi's normal unsandboxed Bash backend. For an
active Check mode, PUM recomputes the policy from the exact approved command,
the authoritative working directory, the configured roots, and deterministic
access analysis. Model input cannot supply policy fields.

The project and configured roots are writable. Explicit on-mode external reads
mount read-only. PUM configuration and common credential paths are denied, and
credential-shaped or process-injection environment variables are removed. A
private temporary directory is supplied. Safe pi metadata such as `PI_PROVIDER`,
`PI_MODEL`, and `PI_REASONING_LEVEL` stays available; session paths and
identifiers are withheld.

Network access is denied unless deterministic analysis recognizes an approved
network operation. Bubblewrap's host-network mode is all-or-nothing and is
**not domain-filtered**; Windows likewise grants or withholds broad network
capabilities without hostname allowlists.

Both the Bash tool and managed shells run through this backend, so a shell
cannot run work that Bash would have confined. **External triggers do not**:
their synchronous spawn boundary cannot carry the exact approved policy object
into execution, and recomputing a second policy there would weaken approval
identity. Triggers keep deterministic Check mode and direct argv supervision.
PUM never sandboxes the TUI/model process itself.

## Outer sandbox (MVP)

`pum s` and `pum sr` run PUM inside `claudebox`. They currently require Linux;
on Windows, install PUM and `claudebox` inside WSL 2.

PUM requires `claudebox` launcher protocol 1 — run `pum ss` to verify the
executable and protocol. The runtime also needs `runsc`, `pasta`, `iptables`,
`ip6tables`, `ip`, `nsenter`, and `unshare`.

The launcher hides the normal home mount and mounts the project, explicit extra
directories, the required PUM runtime files, and the PUM configuration
directory. The sandboxed child uses the saved Check mode setting and disables
nested Bubblewrap.

This MVP mounts the PUM configuration directory, credentials included, inside
gVisor. With Check mode on it blocks credential access through supported tools,
but it is not a second OS boundary. A host-side credential broker is planned.
