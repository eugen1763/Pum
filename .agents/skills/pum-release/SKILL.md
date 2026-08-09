---
name: pum-release
description: Prepares and publishes a PUM patch release. Use when releasing pum-agent: closes queued agent work, audits README.md and AGENTS.md, writes CHANGELOG.md, bumps the patch version, validates the package, commits, tags, publishes through GitHub Actions, and verifies npm and GitHub Releases.
compatibility: Requires Bun, Git, GitHub CLI authentication, npm trusted publishing, an npm NPM_TOKEN secret for dist-tags in the GitHub npm environment, and the PUM repository release workflow.
---

# PUM Patch Release

Use this skill only from the PUM repository root. Treat releasing as a repository mutation with remote and package-registry effects. Never expose, print, store, or commit npm tokens or provider credentials.

## Release contract

A release is complete only when all of these are true:

1. Every queued implementation task is finished.
2. Every retained managed subagent and descendant is merged or otherwise validly closed, deepest-first.
3. `README.md` accurately describes the shipped product.
4. `AGENTS.md` accurately describes the shipped architecture, controls, invariants, and testing constraints.
5. `CHANGELOG.md` contains a dated entry for the exact release version.
6. `package.json` contains the exact release version and `bun.lock` is regenerated and consistent. Bun does not store the root workspace version in this lockfile format.
7. Local validation passes.
8. The release commit and matching annotated tag are pushed.
9. Ubuntu and Windows CI pass for the release commit/tag.
10. npm and the GitHub Release both contain the exact version. Prereleases have both `beta` and `latest` npm tags.

Do not move or reuse a published tag. If a tagged release fails after publication or the release contents change, prepare a newer version.

## 1. Preflight

Read these files completely before changing anything:

- `package.json`
- `bun.lock`
- `README.md`
- `AGENTS.md`
- `RELEASING.md`
- `.github/workflows/ci.yml`
- `.github/workflows/release.yml`
- `CHANGELOG.md`, if it exists

Then:

1. Confirm the current branch is `main`.
2. Inspect `git status --short --branch`.
3. Fetch tags and inspect local versus remote state without discarding local work.
4. Perform one managed-agent status check. Do not release while any retained subagent exists at any status. Close descendants deepest-first and parents last.
5. Confirm no merge, rebase, cherry-pick, or revert is in progress.
6. Find the latest release tag and review every commit since it.

Useful inspection commands:

```bash
git branch --show-current
git status --short --branch
git tag --list 'v*' --sort=-version:refname
git log --oneline --decorate <latest-tag>..HEAD
git diff --stat <latest-tag>..HEAD
```

Never clean or reset unrelated work to make the release convenient.

## 2. Determine the next patch version

Accept an explicit version when the user supplies one. Otherwise compute a new patch line:

- Stable `X.Y.Z` becomes `X.Y.(Z+1)`.
- Prerelease `X.Y.Z-LABEL.N` becomes `X.Y.(Z+1)-LABEL.1`.

For example, `0.1.0-beta.3` becomes `0.1.1-beta.1`. This is a patch release, not merely another prerelease build of the old patch.

Validate that:

- the version is valid SemVer;
- local tag `v<VERSION>` does not exist;
- remote tag `v<VERSION>` does not exist;
- npm does not already contain `pum-agent@<VERSION>`;
- prerelease versions will publish under npm tag `beta` and then move `latest` to the same exact version;
- stable versions will publish directly under `latest`.

Confirm that the GitHub `npm` environment contains an `NPM_TOKEN` secret. Inspect only secret names, never values. The token must be granular, limited to `pum-agent`, read/write, configured with Bypass 2FA, and given the shortest practical expiration. Trusted publishing remains responsible for `npm publish`; the token is only for `npm dist-tag add`.

## 3. Audit README.md

Review all user-facing changes since the latest release. Update `README.md` wherever the release changed actual behavior.

At minimum verify:

- Quick Start and installation use `bun i -g pum-agent@beta` for beta releases and the correct stable command when stable.
- The executable remains `pum`.
- Feature summaries include newly shipped major capabilities.
- Tool lists include newly model-callable tools.
- Controls and slash commands match the sole keyboard dispatcher in `src/app.tsx`.
- Settings, Check mode profiles, subagent capacity, trigger behavior, cache behavior, session history, and input behavior are current.
- Requirements and Windows limitations are accurate.
- Security warnings match actual command, trigger, credential, and approval behavior.
- Screenshots and captions are not claimed to show behavior they no longer represent.

Do not add release hype or internal implementation detail. Do not change README merely to produce a diff; an explicit audit with no necessary edit is acceptable only when it is demonstrably current.

## 4. Audit AGENTS.md

Treat `AGENTS.md` as an executable architecture contract. Update it for every shipped change that affects future coding agents.

At minimum verify:

- The layout table includes important new source modules.
- The key table matches `src/app.tsx` and Help.
- Locked decisions cover new persistence, ownership, safety, trigger, cache, session, and subagent lifecycle rules.
- Active-agent capacity and recursive descendant closure rules are current.
- Model tools and main/child routing rules are current.
- Check mode coverage and approval behavior are current.
- New platform constraints and failure modes are documented under “Things that bite”.
- Testing guidance includes any new deterministic adapters, mock processes, Windows behavior, or TUI requirements.
- Obsolete decisions and outdated numeric limits are removed.

Prefer concise durable invariants over a chronological feature list.

## 5. Write CHANGELOG.md

Create `CHANGELOG.md` if it does not exist. Use a compact Keep a Changelog-style structure:

```markdown
# Changelog

All notable changes to PUM are documented in this file.

## [VERSION] - YYYY-MM-DD

### Added
- ...

### Changed
- ...

### Fixed
- ...

### Security
- ...
```

Rules:

- Use the release date in local calendar form `YYYY-MM-DD`.
- Include only headings that have entries.
- Describe user-visible behavior and important safety or compatibility changes.
- Consolidate related commits into one clear bullet.
- Do not paste commit subjects as-is.
- Do not include secrets, internal session content, temporary paths, agent IDs, or debugging noise.
- Mention breaking behavior explicitly even during beta.
- Preserve previous release entries unchanged.
- Add comparison links at the bottom when practical.

Derive the entry from the complete diff and commit range since the latest tag, plus the final README and AGENTS audits.

## 6. Update version metadata

Update the exact version in `package.json`. Regenerate `bun.lock` with Bun so dependency and workspace metadata remain consistent. Bun lockfile version 1 does not store the root workspace package version. Do not add an unsupported field and do not create a `package-lock.json`.

After updating:

```bash
bun install
bun install --frozen-lockfile
```

Inspect the resulting diff. The release version must be identical in:

- `package.json`
- tag name `v<VERSION>`

Confirm that `bun install --frozen-lockfile` accepts `bun.lock` after the version change.

Update documentation references to an exact old version only when they are meant to track the current release. Keep `@beta` installation instructions for prereleases.

## 7. Validate the release candidate

Run all checks from the final release tree:

```bash
bun install --frozen-lockfile
bun test
bun run typecheck
git diff --check
npm pack --dry-run
bun run pack:check
```

Also inspect the packed file list. Confirm it contains runtime source, README/package metadata supplied automatically by npm, and LICENSE, while excluding tests, temporary output, worktrees, sessions, credentials, screenshots not intended for packaging, and skill internals unless deliberately packaged.

If any check fails, fix it before committing and rerun the affected focused checks plus the full required sequence.

## 8. Commit and tag

Review the complete release diff. It should include:

- `CHANGELOG.md`
- version changes
- required README updates
- required AGENTS updates
- any final release-only corrections

Create one release commit:

```bash
git add CHANGELOG.md README.md AGENTS.md package.json bun.lock
git commit -m "Release <VERSION>"
git tag -a "v<VERSION>" -m "PUM <VERSION>"
```

Include other intentional release files in `git add` when necessary. Never stage unrelated temporary files.

Verify:

```bash
git status --short --branch
git show --stat --oneline HEAD
git show "v<VERSION>" --no-patch
```

## 9. Push and observe workflows

Push the release commit first, then the tag:

```bash
git push origin main
git push origin "v<VERSION>"
```

Do not bypass Check mode or rewrite the command to evade a rejection. If a hard safety policy blocks the push, report the exact blocked operation and ask the user to run it or change the active policy deliberately.

Identify the CI and Release workflow runs for the exact commit/tag. Use `gh run watch <run-id>` for each run rather than shell sleep loops or repeated polling. Inspect failed logs once when a run fails.

The release workflow must reject mismatched tags. Never change a release tag to point at a later fix.

The workflow publishes through npm trusted publishing. For a prerelease, it then uses the GitHub `npm` environment secret `NPM_TOKEN` to assign the exact published version to `latest`. Do not perform the normal `latest` promotion manually and do not request an OTP in chat. If the promotion fails, inspect the one failed workflow log and verify that the secret exists, remains unexpired, has package write access, and has Bypass 2FA enabled.

## 10. Verify publication

After successful workflows, verify all of the following:

- `npm view pum-agent@<VERSION> version` returns the exact version.
- Stable releases have `latest` pointing to the exact version.
- Prereleases have both `beta` and `latest` pointing to the exact version.
- `gh release view v<VERSION>` exists.
- Prerelease versions are marked as GitHub prereleases.
- A clean temporary global install exposes the `pum` executable.

Example installation check:

```bash
bun i -g pum-agent@beta
pum --help
```

Use an isolated install location when changing the developer machine’s global packages would be disruptive.

## 11. Final report

Report:

- released version and tag;
- changelog summary;
- README and AGENTS audit outcome;
- local validation totals;
- Ubuntu and Windows CI result;
- npm publication and all required dist-tags;
- GitHub Release result;
- installation verification;
- any manual action still required.

Do not claim release success until npm and GitHub verification both succeed.
