# Releasing PUM

PUM uses the npm package name `pum-agent`. The installed executable remains `pum`.

## npm authentication

The Release workflow uses the GitHub `npm` environment secret `NPM_TOKEN` for
both package publication and exact dist-tag updates. GitHub OIDC remains enabled
so `npm publish --provenance` can attach provenance to the release.

Configure the token as follows:

1. Limit it to the `pum-agent` package.
2. Grant read and write access.
3. Enable **Bypass 2FA** for the token.
4. Use the shortest practical expiration and rotate the token before expiry.
5. Add the token as `NPM_TOKEN` in the GitHub `npm` environment.
6. Never print the value, place it in repository files, or paste it into issue or chat text.

For prereleases, the workflow publishes with `beta`, then assigns the exact version to `latest`. Stable releases publish directly with `latest`.

## Release checklist

1. Update `package.json` to the exact release version.
2. Run `bun install --frozen-lockfile`.
3. Run `bun test`.
4. Run `bunx tsc --noEmit`.
5. Run `git diff --check`.
6. Run `npm pack --dry-run --ignore-scripts --cache node_modules/.cache/npm`.
7. Run `bun run pack:check`.
8. Commit the version and release changes.
9. Push the release commit to `main` without creating or pushing a tag.
10. Identify the exact CI run for that commit and use `gh run watch <run-id> --exit-status` until both Ubuntu and Windows jobs succeed.
11. If CI fails, inspect its failed log once, fix the failure in a new commit, push it, and repeat the exact-commit CI gate. Never tag a queued, running, or failed commit.
12. After green `main` CI, create and push a signed or annotated tag named `v<package version>`.
13. Watch the exact tag CI and Release workflow runs to completion.
14. Run `npm install pum-agent@<VERSION> --ignore-scripts --prefix node_modules/.pum-install --cache node_modules/.cache/npm` after publication.
15. Run `node_modules/.pum-install/node_modules/.bin/pum --help` to verify the installed executable.

The workflow rejects a tag that differs from `package.json`. The workflow never changes the package version.

Do not move or reuse a published tag. If a tagged candidate needs changes, prepare a newer version.

Versions with a hyphen publish under the npm `beta` tag and are then promoted to `latest`. Other versions publish directly under `latest`.
