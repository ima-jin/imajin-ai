#!/usr/bin/env bash
#
# Publish one packages/<name> to a single registry.
#
# Usage: scripts/publish-package.sh <package-name> <registry-url> [dry-run]
#
# Reads NODE_AUTH_TOKEN from the environment (never echoed, never written to
# disk as a literal — the .npmrc written for GitHub Packages uses npm's
# ${VAR} expansion so the token is only resolved in-memory by npm).
#
# The workspace copy under packages/<name> is never published directly. It is
# private: true and named @imajin/*, which we don't own on npm.
# scripts/prepare-npm-publish.mjs materializes the publishable @ima-jin/*
# copy into a temp dir, and that copy is what gets published here.
set -euo pipefail

PKG="${1:?package name required}"
REGISTRY="${2:?registry url required}"
DRY_RUN="${3:-false}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PUBLISH_DIR="$(mktemp -d)"
trap 'rm -rf "$PUBLISH_DIR"' EXIT

# Rewrite names/scope, resolve workspace:* deps, drop private/devDependencies.
node scripts/prepare-npm-publish.mjs "packages/$PKG" "$PUBLISH_DIR"

echo "--- package.json ---"
cat "$PUBLISH_DIR/package.json"
echo ""
echo "--- files ---"
# `|| true` because head closing the pipe early SIGPIPEs find, which set -o
# pipefail would otherwise turn into a failed publish for any package with
# more than 50 files.
find "$PUBLISH_DIR" -type f | head -50 || true

PUBLISH_ARGS=("--registry" "$REGISTRY")

case "$REGISTRY" in
*npm.pkg.github.com*)
  # actions/setup-node only writes auth for registry.npmjs.org, so GitHub
  # Packages needs its own auth line. A project-level .npmrc beats the user
  # config, and npm never packs .npmrc into the tarball. The single-quoted
  # ${NODE_AUTH_TOKEN} is deliberate: npm expands it when it reads the file,
  # so no token value is ever written to disk.
  #
  # No --access flag here: GitHub Packages derives visibility from the linked
  # repository, and passing --access public is meaningless (at best) for it.
  {
    echo '@ima-jin:registry=https://npm.pkg.github.com'
    echo '//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}'
  } >"$PUBLISH_DIR/.npmrc"
  ;;
*)
  PUBLISH_ARGS+=("--access" "public")
  ;;
esac

cd "$PUBLISH_DIR"
if [ "$DRY_RUN" = "true" ]; then
  echo "DRY RUN — skipping publish to $REGISTRY"
  npm publish --dry-run "${PUBLISH_ARGS[@]}" 2>&1 || true
else
  npm publish "${PUBLISH_ARGS[@]}"
  echo "Published $PKG to $REGISTRY"
fi
