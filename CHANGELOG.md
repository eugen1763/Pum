# Changelog

All notable changes to PUM are documented in this file.

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

[0.1.1-beta.1]: https://github.com/eugen1763/Pum/compare/v0.1.0-beta.3...v0.1.1-beta.1
