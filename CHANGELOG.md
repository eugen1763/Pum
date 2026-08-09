# Changelog

All notable changes to PUM are documented in this file.

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

[0.1.3-beta.2]: https://github.com/eugen1763/Pum/compare/v0.1.3-beta.1...v0.1.3-beta.2
[0.1.3-beta.1]: https://github.com/eugen1763/Pum/compare/v0.1.2-beta.1...v0.1.3-beta.1
[0.1.2-beta.1]: https://github.com/eugen1763/Pum/compare/v0.1.1-beta.1...v0.1.2-beta.1
[0.1.1-beta.1]: https://github.com/eugen1763/Pum/compare/v0.1.0-beta.3...v0.1.1-beta.1
