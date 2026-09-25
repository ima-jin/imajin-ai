#!/usr/bin/env bash
#
# Out-of-repo smoke test for the published Imajin SDK (#1982).
#
# Proves the actual acceptance criterion: "a fresh repo can `pnpm add
# @imajin/auth` [as `@ima-jin/auth`] from the registry and authenticate
# against the kernel with no path into the monorepo." It does this for real —
# a scratch directory OUTSIDE this repo, a real `npm install` against GitHub
# Packages, then scripts/smoke/sdk-mint-verify.mjs run against the installed
# copy, importing it only by its published package specifier.
#
# Usage:
#   GITHUB_PACKAGES_TOKEN=<token with read:packages> \
#     scripts/smoke-test-sdk-install.sh auth@0.8.2 [config@0.8.2 ...]
#
# Each argument is a `<package>@<version>` pair, `<package>` being the
# workspace-local name (e.g. `auth`, not `@ima-jin/auth`). Defaults to
# `auth@<the version currently in packages/auth/package.json>` when no
# arguments are given, so a bare invocation smoke-tests "whatever main says
# was just published".
#
# After installing the requested specs, this also reads each installed
# package's own (already-published, already-scope-rewritten) package.json
# and `npm install --no-save`s every declared peerDependency at its declared
# range (#2376) — e.g. `next`, and `@ima-jin/auth`'s optional `drizzle-orm`.
# A real consumer of these packages is a Next app and will always have
# `next` in its own tree; the smoke test has to model that or it fails on
# the exact thing every real install needs (`Cannot find module
# '.../next/server'`), which a bare `npm install <specs>` never surfaces
# since npm does not auto-install non-optional peers, let alone optional
# ones.
#
# Reads GITHUB_PACKAGES_TOKEN, falling back to GITHUB_TOKEN (the shape
# .github/workflows/smoke-sdk-install.yml runs this with, authenticated by
# the workflow's own ephemeral secrets.GITHUB_TOKEN — no new secret). Never
# echoed, never written to disk except inside a throwaway .npmrc that npm
# itself expands from the environment (same pattern as
# scripts/publish-package.sh's GitHub Packages leg).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

TOKEN="${GITHUB_PACKAGES_TOKEN:-${GITHUB_TOKEN:-}}"
if [[ -z "$TOKEN" ]]; then
  echo "FAIL: set GITHUB_PACKAGES_TOKEN (or GITHUB_TOKEN) to a token with read:packages" >&2
  exit 1
fi

# Default: smoke-test auth alone, at whatever version is currently committed
# — "whatever main says was just published" for a bare invocation.
if [[ "$#" -eq 0 ]]; then
  DEFAULT_VERSION="$(node -e "console.log(require('$REPO_ROOT/packages/auth/package.json').version)")"
  set -- "auth@${DEFAULT_VERSION}"
fi

SCRATCH_DIR="$(mktemp -d)"
trap 'rm -rf "$SCRATCH_DIR"' EXIT
cd "$SCRATCH_DIR"

# The .npmrc shape a real external consumer needs — see
# docs/packages/PUBLISHING.md's "Consumer: installing from GitHub Packages".
# Single-quoted ${NODE_AUTH_TOKEN}: npm expands it when it reads the file, so
# the token itself never touches disk as a literal.
export NODE_AUTH_TOKEN="$TOKEN"
{
  echo '@ima-jin:registry=https://npm.pkg.github.com'
  echo '//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}'
} >.npmrc

npm init -y >/dev/null

INSTALL_SPECS=()
for pkg_at_version in "$@"; do
  INSTALL_SPECS+=("@ima-jin/${pkg_at_version}")
done

echo "Installing ${INSTALL_SPECS[*]} from GitHub Packages into $SCRATCH_DIR ..."
npm install --no-save "${INSTALL_SPECS[@]}"

echo "--- installed ---"
npm ls --depth=0 || true

# Real consumers always bring their own copy of every declared peer (the
# published manifest's peerDependencies, at whatever range prepare-npm-
# publish.mjs resolved workspace:* to) — see the module docstring. Collect
# the declared peers of every package just installed, deduplicated by name,
# and install them the same way a consuming app's own `npm install` would.
declare -A SEEN_PEERS
PEER_SPECS=()
for pkg_at_version in "$@"; do
  pkg="${pkg_at_version%@*}"
  PKG_JSON="node_modules/@ima-jin/${pkg}/package.json"
  if [[ ! -f "$PKG_JSON" ]]; then
    echo "FAIL: expected $PKG_JSON to exist after installing @ima-jin/${pkg_at_version}" >&2
    exit 1
  fi
  while IFS=$'\t' read -r peer_name peer_range; do
    [[ -z "$peer_name" ]] && continue
    if [[ -z "${SEEN_PEERS[$peer_name]:-}" ]]; then
      SEEN_PEERS["$peer_name"]="$peer_range"
      PEER_SPECS+=("${peer_name}@${peer_range}")
    fi
  done < <(PKG_JSON="$PKG_JSON" node -e '
const fs = require("node:fs");
const pkg = JSON.parse(fs.readFileSync(process.env.PKG_JSON, "utf8"));
const peers = pkg.peerDependencies || {};
for (const [name, range] of Object.entries(peers)) {
  process.stdout.write(name + "\t" + range + "\n");
}
')
done

if [[ "${#PEER_SPECS[@]}" -gt 0 ]]; then
  echo "Installing declared peerDependencies ${PEER_SPECS[*]} ..."
  npm install --no-save "${PEER_SPECS[@]}"
  echo "--- installed (with peers) ---"
  npm ls --depth=0 || true
else
  echo "No declared peerDependencies to install."
fi

# Node's ESM resolver looks for node_modules relative to the *importing
# file's* own path, not the process's cwd — copying the smoke script into
# the scratch dir (rather than running it in place from $REPO_ROOT) is what
# makes `import('@ima-jin/auth')` inside it resolve to the package this
# script just installed, instead of falling through to (or failing to find
# anything in) the monorepo's own node_modules tree.
cp "$REPO_ROOT/scripts/smoke/sdk-mint-verify.mjs" ./sdk-mint-verify.mjs

echo "Running mint/verify smoke check against the installed @ima-jin/auth ..."
node ./sdk-mint-verify.mjs @ima-jin/auth
