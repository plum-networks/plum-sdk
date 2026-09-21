#!/usr/bin/env bash
# Publish the @plumbox/* packages to npm, in dependency order, idempotently.
#
#   bash scripts/publish.sh              # publish everything not already on npm
#   bash scripts/publish.sh --dry-run    # say what it would do, publish nothing
#   bash scripts/publish.sh @plumbox/ui  # one package (and only that one)
#
# Idempotent by construction: for each package it asks npm whether that exact
# name@version already exists and skips it if so. Re-running after a partial
# failure therefore picks up where it stopped — npm refuses to overwrite a
# published version anyway, and this turns that hard error into a "skipped".
#
# Bumping a version is a separate, deliberate act (see RELEASING.md); this
# script never edits a package.json.
set -euo pipefail

HERE=$(cd "$(dirname "$0")/.." && pwd)
cd "$HERE"

# Dependency order. Nothing here imports anything else here at runtime, so this
# is really "source of truth first": the manifest schema, then the crypto
# primitive, then the pieces that document themselves in terms of both.
ORDER=(
  "@plumbox/manifest"
  "@plumbox/oprf"
  "@plumbox/ui"
  "@plumbox/client"
  "@plumbox/dev"
)

DRY_RUN=0
ONLY=()
for arg in "$@"; do
  case "$arg" in
    --dry-run|-n) DRY_RUN=1 ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    @plumbox/*) ONLY+=("$arg") ;;
    *) echo "publish.sh: unknown argument \"$arg\" (try --help)" >&2; exit 2 ;;
  esac
done

wants() {
  [ ${#ONLY[@]} -eq 0 ] && return 0
  local p
  for p in "${ONLY[@]}"; do [ "$p" = "$1" ] && return 0; done
  return 1
}

version_of() { node -p "require('./packages/$1/package.json').version"; }
dir_of() {
  case "$1" in
    "@plumbox/dev") echo cli ;;
    "@plumbox/client") echo client ;;
    "@plumbox/manifest") echo manifest ;;
    "@plumbox/oprf") echo oprf ;;
    "@plumbox/ui") echo ui ;;
    *) echo "publish.sh: no directory known for $1" >&2; exit 2 ;;
  esac
}

if [ "$DRY_RUN" -eq 0 ]; then
  who=$(npm whoami 2>/dev/null || true)
  if [ -z "$who" ]; then
    echo "publish.sh: not logged in to npm — run \`npm login\` (or set NPM_TOKEN in .npmrc) first." >&2
    exit 1
  fi
  echo "npm user: $who"
fi

# A clean tree, a clean install and green tests before anything leaves the
# machine. Tracked changes are fatal: a published tarball has to correspond to
# a commit. Untracked files only warn — they cannot reach a tarball unless they
# sit inside a path the package's `files` whitelist names, and scratch
# directories in a working copy are normal.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "publish.sh: tracked files are modified — commit or stash first (a published tarball must match a commit)." >&2
  git status --short --untracked-files=no >&2
  if [ "$DRY_RUN" -eq 0 ]; then exit 1; fi
elif [ -n "$(git status --porcelain)" ]; then
  echo "publish.sh: note — untracked files present; check the pack lists below if any sit under dist/ or src/." >&2
fi
npm ci
npm run build --workspaces
npm run typecheck --workspaces --if-present
npm test --workspaces

published=()
skipped=()
for pkg in "${ORDER[@]}"; do
  wants "$pkg" || continue
  dir=$(dir_of "$pkg")
  ver=$(version_of "$dir")
  if [ "$(npm view "$pkg@$ver" version 2>/dev/null || true)" = "$ver" ]; then
    echo "== $pkg@$ver already on npm — skipping"
    skipped+=("$pkg@$ver")
    continue
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "== would publish $pkg@$ver"
    npm pack --dry-run -w "$pkg" >/dev/null
    published+=("$pkg@$ver (dry run)")
    continue
  fi
  echo "== publishing $pkg@$ver"
  npm publish --access public -w "$pkg"
  published+=("$pkg@$ver")
done

echo
echo "published: ${published[*]:-(none)}"
echo "skipped:   ${skipped[*]:-(none)}"
if [ "$DRY_RUN" -eq 0 ] && [ ${#published[@]} -gt 0 ]; then
  echo
  echo "Now tag the commit so the tarball can be traced back:"
  for p in "${published[@]}"; do echo "  git tag ${p/@plumbox\//}"; done
  echo "  git push --tags"
fi
