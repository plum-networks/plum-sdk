# Releasing the `@plumbox/*` packages

Five packages live in this repo and each has its own version. They do not
depend on one another at runtime, so they are released independently — you do
not have to bump all five because one changed.

| Package | Directory | npm |
|---|---|---|
| `@plumbox/manifest` | `packages/manifest` | the `manifest.json` JSON Schema |
| `@plumbox/oprf` | `packages/oprf` | zero-knowledge box discovery |
| `@plumbox/ui` | `packages/ui` | panel design system |
| `@plumbox/client` | `packages/client` | outside-the-box client SDK |
| `@plumbox/dev` | `packages/cli` | the `plum-dev` CLI |

`scripts/publish.sh` publishes in that order. Nothing here imports anything
else here, so the order is really "source of truth first" — if a release ever
introduces a real dependency, add it to `ORDER` in the script ahead of its
dependents.

## Prerequisites (once per machine)

- Node **18** or newer. Everything is built with `--target node18` and tested
  on the Node the contributor has; do not raise `engines.node` without deciding
  to drop Node 18 users.
- `npm login` against the `plumbox` npm organisation, with **publish** rights on
  the `@plumbox` scope. In CI use an automation token in `.npmrc`
  (`//registry.npmjs.org/:_authToken=${NPM_TOKEN}`) instead.
- The scope must exist and the first publish of each package must be public.
  Every `package.json` here carries `"publishConfig": {"access": "public"}`, so
  `npm publish` does not need `--access public` on the command line — the script
  passes it anyway, because a missing `publishConfig` is a silent private
  publish and a private publish on a free org is an outright failure.

## Cutting a release

1. **Bump the version** in the package's `package.json`. Semver as usual;
   these are all pre-1.0, so a breaking change bumps the minor.
2. **Write down what changed** in that package's `README.md` if the surface
   moved. There is no CHANGELOG yet; the git log is it.
3. **Commit.** A published tarball must correspond to a commit — `publish.sh`
   refuses to run with tracked changes in the tree. Untracked files only warn;
   they cannot reach a tarball unless they sit inside a path the package's
   `files` whitelist names.
4. **Rehearse:**
   ```bash
   bash scripts/publish.sh --dry-run
   ```
   This runs `npm ci`, `npm run build --workspaces`, `npm run typecheck
   --workspaces --if-present`, `npm test --workspaces` and `npm pack --dry-run`
   for every package, and prints what it *would* publish.
   Read the pack file lists: anything that is not `dist/`, `src/` (for
   `@plumbox/ui` and `@plumbox/manifest`), `README.md`, `LICENSE` and
   `package.json` is a mistake in the `files` whitelist.
5. **Publish:**
   ```bash
   bash scripts/publish.sh                 # everything that is not on npm yet
   bash scripts/publish.sh @plumbox/dev    # or just one
   ```
6. **Tag and push:**
   ```bash
   git tag dev-0.1.0        # <package-dir-name>-<version>; the script prints these
   git push --tags
   ```

`typecheck` is `tsc --noEmit` and is separate from `build` on purpose: tsup
transpiles without type-checking, and vitest does the same, so a package can
build green and test green while `tsc` has four errors in it. That is exactly
what was true of `@plumbox/dev` and `@plumbox/client` until the release prep,
and it is why the check runs before anything is published.

## Why the script is idempotent

Before publishing each package it asks `npm view <pkg>@<version> version`. If
npm already has that exact version the package is skipped, not failed. So:

- re-running after a network failure half-way through finishes the job;
- running it when nothing was bumped is a no-op;
- you cannot accidentally "republish" — npm forbids overwriting a version, and
  the script turns that hard error into a visible `skipped` line.

It never edits a `package.json`. Bumping a version is a commit a human makes.

## Verifying a published package

```bash
npm view @plumbox/dev versions
npm view @plumbox/dev dist.tarball

# install it the way a user would, in a scratch directory
mkdir /tmp/plumcheck && cd /tmp/plumcheck && npm init -y
npm i @plumbox/dev && npx plum-dev --version
```

For `@plumbox/dev` specifically, check that the shebang survived
(`head -1 node_modules/@plumbox/dev/dist/cli.js` → `#!/usr/bin/env node`) and
that `dist/plum-sdk-mock.js` is present — `plum-dev serve` serves it, and it is
copied in by the build rather than living in `src/`.

## Unpublishing / mistakes

npm allows `npm unpublish <pkg>@<version>` only within 72 hours and only if
nothing depends on it. Prefer publishing a fixed patch version and
`npm deprecate @plumbox/x@<bad> "use <good>"`. If a secret ever lands in a
tarball, unpublish **and** rotate the secret; assume the tarball was mirrored.

## What is not released from here

- `plumsvc/` is a **Go** module, consumed as
  `github.com/plum-networks/plum-sdk/plumsvc`. It is released by tagging this
  repo `plumsvc/vX.Y.Z` and pushing the tag; there is no npm step.
- `src/plum-sdk.js` is not published to npm at all. The box serves it from its
  own binary; `scripts/vendor-to-core.sh` copies it into `plum-box-core`, and it
  ships with a core release.
- `examples/` is documentation, not a package.
