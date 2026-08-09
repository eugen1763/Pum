# Releasing PUM

PUM uses the npm package name `@eugen1763/pum`. The installed executable remains `pum`.

## First-publish bootstrap

npm trusted publishing requires an existing package. Complete these steps once:

1. Confirm that the `@eugen1763` npm scope belongs to the release owner.
2. Run all validation commands from the release commit.
3. Create a granular npm token that can create the package under the scope.
4. Add the token as the `NPM_TOKEN` GitHub Actions secret.
5. Set the GitHub environment to `npm`.
6. Push the first release tag and let `release.yml` publish the package.
7. Open the new package settings on npm.
8. Add the GitHub Actions trusted publisher for `eugen1763/Pum`.
9. Set the workflow filename to `release.yml`.
10. Set the GitHub environment to `npm`.
11. Delete the `NPM_TOKEN` GitHub Actions secret.

Later releases use GitHub OIDC through `id-token: write`. Do not restore `NPM_TOKEN` after the bootstrap publish.

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

Versions with a hyphen publish under the npm `beta` tag. Other versions publish under the npm `latest` tag.
