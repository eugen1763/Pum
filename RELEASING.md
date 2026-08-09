# Releasing PUM

PUM uses the npm package name `pum-agent`. The installed executable remains `pum`.

## First-publish bootstrap

npm trusted publishing requires an existing package. Complete these steps once:

1. Confirm that the `pum-agent` npm package name is still available.
2. Run all validation commands from the release commit.
3. Create a granular npm token that can create the package under the scope.
4. Add the token as the `NPM_TOKEN` GitHub Actions secret.
5. Set the GitHub environment to `npm`.
6. Push the first release tag and let `release.yml` publish the package.
7. Open the new package settings on npm.
8. Add the GitHub Actions trusted publisher for `eugen1763/Pum`.
9. Set the workflow filename to `release.yml`.
10. Set the GitHub environment to `npm`.
11. Revoke the broad bootstrap token after trusted publishing is configured.
12. Create a replacement granular token limited to `pum-agent`, then store it as `NPM_TOKEN` in the GitHub `npm` environment.

Later releases use GitHub OIDC through `id-token: write` for publication. `NPM_TOKEN` is reserved for dist-tag updates.

## Dist-tag automation

npm trusted publishing authenticates only `npm publish`. It does not authorize `npm dist-tag add`.

Create a separate granular token for release dist-tags:

1. Limit the token to the `pum-agent` package.
2. Grant read and write access.
3. Enable **Bypass 2FA** for the token.
4. Use the shortest practical expiration and rotate the token before expiry.
5. Add the token as `NPM_TOKEN` in the GitHub `npm` environment.
6. Never use this token for `npm publish`; the workflow keeps publication on short-lived OIDC credentials.

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
