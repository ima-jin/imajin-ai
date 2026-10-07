#!/usr/bin/env bash
#
# Publish one packages/<name> to a single registry.
#
# Usage: scripts/publish-package.sh <package-name> <registry-url> [dry-run]
#
# Auth (never echoed, never written to disk as a literal — every .npmrc written
# here uses npm's ${VAR} expansion so a token is only resolved in-memory by npm):
#   - GitHub Packages: NODE_AUTH_TOKEN (the ephemeral GITHUB_TOKEN).
#   - npmjs.org (#1589): OIDC Trusted Publishing first. npm exchanges the
#     workflow's GitHub OIDC identity (job needs `id-token: write`, npm >=
#     11.5.1) for a short-lived publish credential and signs a provenance
#     attestation (`--provenance`) — no long-lived secret involved. Only if
#     that publish fails AND NPM_FALLBACK_TOKEN is set (the legacy NPM_TOKEN
#     secret, kept until every package has a Trusted Publisher — see
#     docs/npm-publishing.md) is the publish retried with that token.
#     NODE_AUTH_TOKEN is deliberately ignored for npmjs: actions/setup-node
#     exports a placeholder value for it, and a token present in the
#     environment can stop npm from ever attempting the OIDC exchange.
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
# Holds the throwaway per-attempt npm user configs for npmjs.org (see below);
# kept outside $PUBLISH_DIR so it can never be mistaken for package content.
AUTH_DIR="$(mktemp -d)"
trap 'rm -rf "$PUBLISH_DIR" "$AUTH_DIR"' EXIT

# Legacy token for the npmjs fallback only (#1589). Captured now, then removed
# from the environment for npmjs so it can't leak into the OIDC attempt.
FALLBACK_TOKEN="${NPM_FALLBACK_TOKEN:-}"
unset NPM_FALLBACK_TOKEN

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
NPMJS=false

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
*registry.npmjs.org*)
  # --provenance (#1589): sigstore build attestation tying the tarball to this
  # repo/workflow/commit. npmjs only — GitHub Packages doesn't accept npm
  # provenance. Needs `id-token: write` and a matching `repository.url` (see
  # ensureRepositoryForProvenance in scripts/prepare-npm-publish.mjs).
  PUBLISH_ARGS+=("--access" "public" "--provenance")
  NPMJS=true
  ;;
*)
  PUBLISH_ARGS+=("--access" "public")
  ;;
esac

# npmjs.org auth plumbing (#1589). Two single-purpose npm user configs, selected
# per attempt via NPM_CONFIG_USERCONFIG so the result never depends on whatever
# actions/setup-node wrote:
#   oidc.npmrc  — registry only, NO _authToken line, so npm sees no credential
#                 and runs the OIDC exchange.
#   token.npmrc — registry + an _authToken that npm expands from the env var at
#                 read time. Single-quoted on purpose: no token value is ever
#                 written to disk. Used only by the fallback.
OIDC_NPMRC="$AUTH_DIR/oidc.npmrc"
TOKEN_NPMRC="$AUTH_DIR/token.npmrc"
if [[ "$NPMJS" = "true" ]]; then
  # See header: a (placeholder) token in the environment must not reach npm or
  # the registry lookup below.
  unset NODE_AUTH_TOKEN
  REGISTRY_BASE="${REGISTRY%/}"
  printf 'registry=%s/\n' "$REGISTRY_BASE" >"$OIDC_NPMRC"
  {
    printf 'registry=%s/\n' "$REGISTRY_BASE"
    # shellcheck disable=SC2016 # ${NPM_FALLBACK_AUTH} is for npm to expand, not bash
    printf '%s/:_authToken=${NPM_FALLBACK_AUTH}\n' "${REGISTRY_BASE#*:}"
  } >"$TOKEN_NPMRC"
fi

# Publish to npmjs.org via OIDC; on failure fall back to the legacy token only
# if one was provided. Always logs which path published so the operator can see
# when every package has moved off the token.
publish_npmjs() {
  if NPM_CONFIG_USERCONFIG="$OIDC_NPMRC" npm publish "${PUBLISH_ARGS[@]}"; then
    echo "Authenticated via OIDC Trusted Publishing (provenance attached)."
    return 0
  fi
  if [[ -z "$FALLBACK_TOKEN" ]]; then
    echo "::error::OIDC publish of $PKG failed and no NPM_TOKEN fallback is configured. Check the Trusted Publisher config for this package — see docs/npm-publishing.md." >&2
    return 1
  fi
  echo "::warning::OIDC publish of $PKG failed — retrying with the legacy NPM_TOKEN fallback. Configure a Trusted Publisher for this package so the token can be retired (docs/npm-publishing.md)." >&2
  NPM_FALLBACK_AUTH="$FALLBACK_TOKEN" NPM_CONFIG_USERCONFIG="$TOKEN_NPMRC" npm publish "${PUBLISH_ARGS[@]}"
  echo "Authenticated via legacy NPM_TOKEN fallback."
}

cd "$PUBLISH_DIR"

# Idempotency (#2578): a version already on this registry is skipped, not a
# failure, so re-running a release publish (or resuming a partial one) is safe.
# Runs from $PUBLISH_DIR so the GitHub Packages .npmrc above applies to the
# lookup too. If the registry state can't be determined (auth/network/5xx) the
# helper exits non-zero and `set -e` fails the step — never a silent skip.
ALREADY_PUBLISHED="$(node "$REPO_ROOT/scripts/npm-package-published.mjs" "$PUBLISH_DIR" "$REGISTRY")"
if [[ "$ALREADY_PUBLISHED" = "published" ]]; then
  echo "Skipping $PKG on $REGISTRY — this version is already published."
  exit 0
fi

if [[ "$DRY_RUN" = "true" ]]; then
  echo "DRY RUN — skipping publish to $REGISTRY"
  if [[ "$NPMJS" = "true" ]]; then
    # Same credential-free config as the real OIDC attempt (a dry run never
    # performs the exchange), so npm doesn't trip over a missing env var.
    NPM_CONFIG_USERCONFIG="$OIDC_NPMRC" npm publish --dry-run "${PUBLISH_ARGS[@]}" 2>&1 || true
  else
    npm publish --dry-run "${PUBLISH_ARGS[@]}" 2>&1 || true
  fi
elif [[ "$NPMJS" = "true" ]]; then
  publish_npmjs
  echo "Published $PKG to $REGISTRY"
else
  npm publish "${PUBLISH_ARGS[@]}"
  echo "Published $PKG to $REGISTRY"
fi
