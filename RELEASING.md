# Releasing PUM

PUM uses the npm package name `pum-agent`. The installed executable remains `pum`.

## npm authentication

The Release workflow publishes through **trusted publishing**: GitHub Actions
presents this job's OIDC identity, npm checks it against the trusted publisher
registered on the package, and grants a credential for that one publish. No
token is stored, so there is nothing to rotate and nothing that works from a
laptop.

The identity npm verifies is the repository, the workflow file, and the
environment, so all three have to match the registration:

| Field | Value |
|---|---|
| Repository | `eugen1763/Pum` |
| Workflow | `release.yml` |
| Environment | `npm` |

Provenance is attached automatically under OIDC. The workflow still passes
`--provenance` so a build that somehow loses it fails rather than publishing
quietly without one.

### The dist-tag exception

A prerelease publishes under `beta` and is then promoted with
`npm dist-tag add`, which is a second registry call. **Trusted publishing does
not cover it** — `v0.2.20-beta.1` published cleanly through OIDC and the
promotion in the same job failed with `E401`. The step needs its own credential,
so keep a package-scoped `NPM_TOKEN` in the `npm` environment:

1. Limit it to the `pum-agent` package.
2. Grant read and write access.
3. Use the shortest practical expiration and rotate it before expiry.
4. Never print the value, place it in repository files, or paste it into issue or chat text.

If the promotion fails, the package **is** published; only the `latest`
dist-tag is stale, and the job says so and prints the one command to run from a
logged-in shell:

```bash
npm dist-tag add pum-agent@<VERSION> latest
```

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

A publish that fails before the registry accepts the tarball leaves nothing
behind: the tag can be re-run with `gh run rerun <run-id> --failed` rather than
retired, because nothing was published under it.

Do not move or reuse a published tag. If a tagged candidate needs changes, prepare a newer version.

Versions with a hyphen publish under the npm `beta` tag and are then promoted to `latest`. Other versions publish directly under `latest`.
