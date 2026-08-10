# Changelog

All notable changes to PUM are documented in this file.

## [0.2.3-beta.1] - 2026-08-10

### Added
- Added `Ctrl+End` to scroll the selected transcript to the bottom and restore sticky scrolling.

### Changed
- Made prompt input wrap at word boundaries with character fallback for long tokens, matching transcript alignment.
- Rendered Check mode rejection text in orange without changing its background and made the `Check mode hard block:` prefix bold.
- Upgraded official GitHub Actions to Node 24-based releases.

### Fixed
- Made cached-task sends transactional so failed main or child delivery leaves entries pending, while successful delivery commits executed state without duplicate assignment races.
- Persisted subagent completion acknowledgements only after the notice enters the parent session, including crash-window retry and replay coverage.
- Stabilized Windows mutation previews by rejecting unmatched drive and UNC roots before remote filesystem identity probing.
- Forced MXC capability probing to select native Windows `whoami` even when Git or MSYS tools appear first in `PATH`.

### Security
- Required managed agents to have authoritative `completed` status and a persisted matching completion notice before merge; idle or other retained states cannot merge.
- Required open cached tasks to execute through `message_cache_send` before assignment and prevented duplicate agents when the authoritative coordination prompt arrives.

## [0.2.2-beta.1] - 2026-08-10

### Added
- Added dynamic terminal titles that report PUM activity and active subagent counts on Windows, Linux, and tmux-compatible terminals.
- Added native Bash sandbox modes with Bubblewrap enforcement on supported Linux hosts and MXC BaseContainer/CreateProcessInSandbox enforcement on supported Windows hosts.

### Changed
- Allowed Balanced Check mode to read explicit non-sensitive external paths while continuing to block external writes, execution, location changes, ambiguous access, and credential paths.
- Classified filesystem access and network intent deterministically, supplied external reads as read-only sandbox grants, denied network access by default, and applied the sandboxed Bash override to main and managed child sessions.
- Added Auto, Require, and Off sandbox settings with visible non-session fallback warnings and fail-closed Require behavior.

### Fixed
- Stopped Windows Check mode from interpreting `printf` and `echo` data as drive-root-relative paths in compound repository-local Git inspection commands.
- Prevented OAuth controller tests from opening a real browser device-code URL.

### Security
- Added private command temporary directories, credential and PUM configuration masks, sensitive environment filtering, process-tree cancellation, and direct external-read upload blocks.
- Rejected the Windows AppContainer+DACL fallback because it can modify persistent host ACLs; PUM accepts only MXC's native BaseContainer tier.

## [0.2.1-beta.1] - 2026-08-10

### Fixed
- Canonicalized Windows short-name, long-name, case, and missing-leaf path identities for additional Check mode roots, edit previews, and containment checks without weakening symlink or junction protections.
- Rejected unapproved Windows UNC edit targets before filesystem probing and made sequential transcript-selection coverage deterministic across CI runners.

### Changed
- Gated release tagging on successful Ubuntu and Windows CI for the exact release commit, with failed candidates fixed in a new commit and revalidated before any tag is created.

## [0.2.0-beta.4] - 2026-08-10

### Added
- Added `/check-path list|add <directory>|remove <directory>|clear` for up to 16 project-scoped additional Check mode roots used by bash, edit, and external-trigger checks.

### Fixed
- Rendered denied tool calls with warning colors, a `!` marker, and the denial reason on the following line, including persisted session replay.
- Stopped caret-only Markdown updates from reparsing streamed headings and briefly exposing their raw marker prefixes.

### Security
- Kept additional Check mode roots subject to canonical validation, credential boundaries, traversal and escaping-link checks, broad-deletion blocks, and the existing hard-rule policy; `apply_patch` remains project-local.

## [0.2.0-beta.3] - 2026-08-10

### Fixed
- Made prerelease dist-tag verification tolerate npm registry propagation after publication, allowing the workflow to proceed to GitHub Release creation.
- Gave the real Git worktree integration test enough time on slower Windows runners and retried transient Windows `EBUSY` cleanup failures without weakening lifecycle assertions.
- Replaced `0.2.0-beta.2` after its package and provenance published successfully but its post-publication verification exited before creating the GitHub Release.

## [0.2.0-beta.2] - 2026-08-10

### Fixed
- Authenticated npm publication and prerelease dist-tag promotion with the existing package-scoped release token while retaining provenance.
- Made status-header agent-count tests deterministic across Windows and Ubuntu without depending on an animated bullet painting in a specific frame.
- Replaced the unpublished `0.2.0-beta.1` candidate after its release workflow failed before npm publication or GitHub Release creation.

## [0.2.0-beta.1] - 2026-08-09

### Fixed
- Open provider OAuth and device-code verification URLs automatically with the platform browser, while keeping selectable URL fallback and rejecting unsafe URLs.
- Copy completed transcript selections to the local clipboard on Windows and macOS, use Linux clipboard commands when available, and use bounded OSC 52 output for remote sessions.
- Enable selection on transcript Markdown renderables despite the missing OpenTUI 0.5.1 React prop type.

### Changed
- Made the release workflow promote prereleases to both npm `beta` and `latest` using a package-scoped `NPM_TOKEN`, while keeping package publication on trusted-publishing OIDC.

## [0.1.3-beta.2] - 2026-08-09

### Fixed
- Made transcript wrapping coverage stable whether OpenTUI paints Markdown content in the test renderer or leaves it unpainted.
- Made exact POSIX `/dev/null` policy fixtures independent of the host operating system, including virtual escaping-symlink coverage on Windows.
- Replaced the unpublished `0.1.3-beta.1` candidate after CI caught both portability failures before npm publication or GitHub Release creation.

## [0.1.3-beta.1] - 2026-08-09

### Added
- Added optional `spawn_subagent` previews with a responsive Markdown approval popup and a separate user note delivered after spawn.
- Added provider-list search and metadata filtering to the login flow.
- Added `pum --help`, `pum -h`, `pum --version`, and `pum -v` with side-effect-free early CLI dispatch.
- Added Up Arrow recall for the newest undelivered user message in the selected main or child transcript.
- Added subtle semantic popup shadows and terminal-height scaling for Settings.

### Changed
- Made the status header stay on exactly one row and remove lower-priority fields progressively as terminal width decreases.
- Made Help categories stack vertically when two columns would clip on narrow terminals.
- Changed Ask mode to require the approval popup for every non-hard-blocked checked call unless an exact prior approval matches.
- Changed Balanced mode to permit complete ordinary project-local work, including long validated patches, while blocking hard rules, suspicious execution, obfuscation, malformed input, and explicit verifier `UNSAFE` decisions.
- Allowed the authoritative main agent to request exact approval for direct `npm publish` and exact-version `npm dist-tag add` calls.

### Removed
- Removed the public synthetic Fire action from external triggers. Manual Run continues to execute the configured process through Check mode.

### Security
- Allowed only the exact POSIX `/dev/null` device through project-boundary checks; other device and external paths remain blocked.
- Bound spawn previews, queued-message recall, and Ask approvals to authoritative main or child identities outside model input.

## [0.1.2-beta.1] - 2026-08-09

### Fixed
- Fixed a Windows session-history metadata test that treated a native nested path as one opaque filename.
- Fixed broad-deletion policy test fixtures by quoting generated Windows paths without weakening production hard blocks.
- Fixed an intermittent `/new` usage-reset test race by waiting for the observable asynchronous session transition.

## [0.1.1-beta.1] - 2026-08-09

### Added
- Added process-local external triggers with supervised executable/argument execution, exact session and subagent routing, Check mode verification, bounded output, lifecycle controls, and a Ctrl+T management popup.
- Added model-callable message-cache tools with stable IDs, user and agent ownership, exact deletion authorization, and normal prompt or batch execution paths.
- Added interactive model questionnaires with selectable options and custom answers for main and managed child agents.
- Added session-history metadata for latest sent messages, on-disk size, and known outgoing, incoming, and cache-read token counts.
- Added configurable active-subagent capacity from 1 through 25, with a default of 10.
- Added a project release skill that audits documentation, writes this changelog, validates, tags, publishes, and verifies patch releases.

### Changed
- Redesigned Check mode with off, strict, balanced, and ask profiles; deterministic hard blocks; structured verdicts; diff-based mutation review; and exact once, session, or project approvals.
- Made managed parent closure recursive and deepest-first. Every retained descendant now blocks finish, merge, and removal.
- Made subagent idle and completion notifications durable and exact per work cycle, including direct-spawner routing and restart-safe delivery deduplication.
- Limited prompt history to the 100 latest sent occurrences plus every stashed occurrence, while preserving duplicates and normalized workspace identities.
- Made Ctrl+C clear the selected non-empty draft while preserving double-Ctrl+C quit on an empty draft.
- Improved streamed Markdown stability, tool-row wrapping, read argument display, rejected tool styling, and Settings Escape behavior.

### Fixed
- Fixed Windows CI portability for Git CRLF checkouts, project-relative path display, structured deletion checks, and exhaustive Markdown streaming tests.
- Fixed session-switch cancellation and focus restoration, child-transcript selection after switching, pending-image protection, and current-session history selection.
- Fixed nested completion routing, duplicate completion reports, pending message ordering, trigger target invalidation, and multiple subagent lifecycle race windows.
- Fixed system-prompt contradictions around approval behavior, idle versus completion, Ctrl+C, and successful `finish_subagent` calls.

### Security
- Added deterministic blocks for project escape, credential access, privilege escalation, persistence, remote-script execution, destructive Git operations, and broad deletion.
- Added sanitized trigger environments, inert templates, strict argument-boundary checks, private bounded output files, and non-overridable hard-block or explicit `UNSAFE` decisions.

[0.2.2-beta.1]: https://github.com/eugen1763/Pum/compare/v0.2.1-beta.1...v0.2.2-beta.1
[0.2.1-beta.1]: https://github.com/eugen1763/Pum/compare/v0.2.0-beta.4...v0.2.1-beta.1
[0.2.0-beta.4]: https://github.com/eugen1763/Pum/compare/v0.2.0-beta.3...v0.2.0-beta.4
[0.2.0-beta.3]: https://github.com/eugen1763/Pum/compare/v0.2.0-beta.2...v0.2.0-beta.3
[0.2.0-beta.2]: https://github.com/eugen1763/Pum/compare/v0.2.0-beta.1...v0.2.0-beta.2
[0.2.0-beta.1]: https://github.com/eugen1763/Pum/compare/v0.1.3-beta.2...v0.2.0-beta.1
[0.1.3-beta.2]: https://github.com/eugen1763/Pum/compare/v0.1.3-beta.1...v0.1.3-beta.2
[0.1.3-beta.1]: https://github.com/eugen1763/Pum/compare/v0.1.2-beta.1...v0.1.3-beta.1
[0.1.2-beta.1]: https://github.com/eugen1763/Pum/compare/v0.1.1-beta.1...v0.1.2-beta.1
[0.1.1-beta.1]: https://github.com/eugen1763/Pum/compare/v0.1.0-beta.3...v0.1.1-beta.1
