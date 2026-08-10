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
6. Run `npm pack --dry-run`.
7. Run `bun run pack:check`.
8. Commit the version and release changes.
9. Create a signed or annotated tag named `v<package version>`.
10. Push the commit and tag.

The workflow rejects a tag that differs from `package.json`. The workflow never changes the package version.

Versions with a hyphen publish under the npm `beta` tag and are then promoted to `latest`. Other versions publish directly under `latest`.
