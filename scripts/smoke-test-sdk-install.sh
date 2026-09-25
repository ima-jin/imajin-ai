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
# After installing the requested specs, this also reads every installed
# `@ima-jin/*` package's own (already-published, already-scope-rewritten)
# package.json and `npm install`s every declared, non-optional
# peerDependency at its declared range (#2376) — e.g. `next`, but not
# `@ima-jin/auth`'s optional `drizzle-orm` (#2380). A real consumer of these
# packages is a Next app and will always have `next` in its own tree; the
# smoke test has to model that or it fails on the exact thing every real
# install needs (`Cannot find module '.../next/server'`), which a bare `npm
# install <specs>` never surfaces since npm does not auto-install
# non-optional peers, let alone optional ones.
#
# Both installs below deliberately omit `--no-save`, unlike the original
# #1982/#2376 versions of this script (#2380): with `--no-save`, npm treats
# whatever is passed on that particular command line as the *entire* desired
# tree for the (untracked) scratch package.json and prunes anything a prior,
# separate `--no-save` install left behind — so the specs installed in phase
# one were being deleted by the peers-only install in phase two. Recording
# both phases in the scratch package.json (thrown away with the whole
# directory on exit anyway) is simpler than pre-resolving peers via registry
# queries before a single combined install, and it's what actually fixes the
# pruning: each install only ever adds to what's already declared.
#
# Each peer is pinned to a concrete version derived from its own declared
# range (scripts/lib/pin-peer-version.mjs) rather than installed at that
# floating range directly — otherwise the exact version smoke-tested drifts
# every time upstream publishes a new release the range still matches,
# including a new major (#2383: this is literally how a `next` peer range of
# `>=15.5.24` picked up Next.js 16 mid-investigation of the bug below).
#
# Even pinned, a peer like `next` ships no `"exports"` field in any published
# version, so plain Node's ESM loader still can't resolve subpaths like
# `next/server` that `@ima-jin/auth` imports (#2383) — after both install
# phases, scripts/lib/shim-esm-subpaths.mjs patches around that; see its
# module docstring for the full root-cause writeup.
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
npm install "${INSTALL_SPECS[@]}"

echo "--- installed ---"
npm ls --depth=0 || true

SPECS=("$@")
assert_specs_present() {
  local context="$1"
  for pkg_at_version in "${SPECS[@]}"; do
    pkg="${pkg_at_version%@*}"
    PKG_JSON="node_modules/@ima-jin/${pkg}/package.json"
    if [[ ! -f "$PKG_JSON" ]]; then
      echo "FAIL: expected $PKG_JSON to exist ${context} (@ima-jin/${pkg_at_version}) (#2380)" >&2
      exit 1
    fi
  done
}
assert_specs_present "after installing the requested specs"

# Real consumers always bring their own copy of every declared, non-optional
# peer (the published manifest's peerDependencies, at whatever range
# prepare-npm-publish.mjs resolved workspace:* to) — see the module
# docstring. Collect the declared peers of every `@ima-jin/*` package now
# present under node_modules — not just the ones requested on the command
# line, since a requested package's own hard dependency on another
# `@ima-jin/*` package (e.g. `@ima-jin/ui` -> `@ima-jin/fair`, #2376) pulls
# that sibling in transitively, and its peerDependencies need modeling too —
# deduplicated by name, and install them the same way a consuming app's own
# `npm install` would.
declare -A SEEN_PEERS
PEER_SPECS=()
for PKG_JSON in node_modules/@ima-jin/*/package.json; do
  [[ -f "$PKG_JSON" ]] || continue
  while IFS=$'\t' read -r peer_name peer_range; do
    [[ -z "$peer_name" ]] && continue
    if [[ -z "${SEEN_PEERS[$peer_name]:-}" ]]; then
      # Pin to the floor of the declared range when it's a single-bound
      # shape (#2383) so the version actually installed is deterministic
      # instead of "whatever the registry's latest matching release happens
      # to be today". Falls back to the declared range as-is when it isn't a
      # shape pin-peer-version.mjs knows how to pin (see its docstring).
      pinned_version="$(node "$REPO_ROOT/scripts/lib/pin-peer-version.mjs" "$peer_range")"
      if [[ -n "$pinned_version" ]]; then
        echo "Pinning peerDependency ${peer_name}@${peer_range} -> ${peer_name}@${pinned_version} (#2383)"
        SEEN_PEERS["$peer_name"]="$pinned_version"
        PEER_SPECS+=("${peer_name}@${pinned_version}")
      else
        echo "WARN: no deterministic pin derivable for ${peer_name}@${peer_range}; installing the declared range as-is" >&2
        SEEN_PEERS["$peer_name"]="$peer_range"
        PEER_SPECS+=("${peer_name}@${peer_range}")
      fi
    fi
  done < <(node "$REPO_ROOT/scripts/lib/read-peer-deps.mjs" "$PKG_JSON")
done

if [[ "${#PEER_SPECS[@]}" -gt 0 ]]; then
  echo "Installing declared peerDependencies ${PEER_SPECS[*]} ..."
  npm install "${PEER_SPECS[@]}"
  echo "--- installed (with peers) ---"
  npm ls --depth=0 || true
  # Regression guard for #2380: the peers-only install above must not have
  # pruned the specs installed in the first phase.
  assert_specs_present "after installing peerDependencies"

  # A pinned peer version doesn't change the fact that e.g. `next` ships no
  # "exports" field in any published version, so plain Node's ESM loader
  # still can't resolve a subpath like `next/server` that `@ima-jin/auth`
  # imports (#2383) — see scripts/lib/shim-esm-subpaths.mjs's module
  # docstring for the full root-cause writeup and why this is a shim on the
  # installed peer rather than a version pin or a synthetic "exports" map.
  echo "Shimming ESM-unresolvable peer subpaths ..."
  node "$REPO_ROOT/scripts/lib/shim-esm-subpaths.mjs" "$SCRATCH_DIR" "${!SEEN_PEERS[@]}"
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
