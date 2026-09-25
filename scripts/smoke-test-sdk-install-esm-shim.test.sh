#!/usr/bin/env bash
# smoke-test-sdk-install-esm-shim.test.sh — regression test for #2383.
#
# scripts/smoke-test-sdk-install.sh installs `@ima-jin/*` SDK packages plus
# their declared peerDependencies (e.g. `next`) into a scratch directory,
# then runs scripts/smoke/sdk-mint-verify.mjs against the installed copy
# with plain `node`. #2383: `@ima-jin/auth` is published `"type": "module"`
# and its top-level barrel eagerly `import`s `next/server` — but `next`
# ships no `"exports"` field in any published version, so plain Node's ESM
# loader can't resolve that bare subpath specifier on its own (only CJS
# `require()` probes the `.js` extension for a subpath; `import` requires an
# exact file match). This fails with "Cannot find module '.../next/server'"
# regardless of which `next` version is installed.
#
# This can't exercise the real scripts/smoke-test-sdk-install.sh directly
# without a real GITHUB_PACKAGES_TOKEN and network access to GitHub
# Packages. What *is* testable without either is the actual mechanism the
# fix relies on: a real ES module statically importing a subpath of a local
# `file:` peer package that has no "exports" field (standing in for `next`,
# no registry involved at all) fails under plain `node`, and
# scripts/lib/shim-esm-subpaths.mjs fixes it — the same fix applied to the
# real smoke script.
#
# Usage: scripts/smoke-test-sdk-install-esm-shim.test.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

FAILURES=0

check() {
  local desc="$1"
  shift
  if "$@"; then
    echo "✅ $desc"
  else
    echo "❌ $desc"
    FAILURES=$((FAILURES + 1))
  fi
}

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

# A throwaway local package standing in for `next`: real subpath files, but
# deliberately no "exports" field, the exact shape every published `next`
# version actually has (#2383).
mkdir -p "$WORKDIR/fake-next"
cat >"$WORKDIR/fake-next/package.json" <<'JSON'
{ "name": "fake-next", "version": "1.0.0", "main": "./index.js" }
JSON
echo 'module.exports = {};' >"$WORKDIR/fake-next/index.js"
# `exports.<name> = ...` (rather than a single `module.exports = {...}`
# object literal) is the shape Node's `cjs-module-lexer` statically
# recognizes to recover named exports for ESM interop — the same shape
# real compiled output (including next/server.js itself) uses (#2383).
cat >"$WORKDIR/fake-next/server.js" <<'JS'
exports.NextResponse = "fake-next-response";
JS

# A throwaway local ESM package standing in for `@ima-jin/auth`: statically
# imports the peer's subpath at module scope, the same way auth's top-level
# barrel does via require-auth.ts (#2383). Named directly under the
# `@ima-jin` scope so npm installs it straight into
# `node_modules/@ima-jin/fake-sdk` — exactly where shimEsmSubpaths.mjs scans.
mkdir -p "$WORKDIR/fake-sdk"
cat >"$WORKDIR/fake-sdk/package.json" <<'JSON'
{ "name": "@ima-jin/fake-sdk", "version": "1.0.0", "type": "module", "main": "./index.js" }
JSON
echo 'import { NextResponse } from "fake-next/server"; export { NextResponse };' >"$WORKDIR/fake-sdk/index.js"

# Packed and installed from tarballs rather than `file:` directory
# references: a `file:` install is a symlink straight back to the source
# directory, so Node's ESM resolver would walk up node_modules from *that*
# real path (which has none) instead of the consumer's, sidestepping the
# exact resolution `next`'s real, tarball-installed packages hit. Packing
# first matches how npm actually lays out a real GitHub Packages install
# (extracted tarball contents, never a symlink) (#2383).
npm pack "$WORKDIR/fake-next" --pack-destination "$WORKDIR" --silent >/dev/null
npm pack "$WORKDIR/fake-sdk" --pack-destination "$WORKDIR" --silent >/dev/null

mkdir -p "$WORKDIR/consumer"
cd "$WORKDIR/consumer"
npm init -y >/dev/null
npm install --no-audit --no-fund --ignore-scripts "$WORKDIR/fake-next-1.0.0.tgz" "$WORKDIR/ima-jin-fake-sdk-1.0.0.tgz" >/dev/null

cat >verify-import.mjs <<'MJS'
const { NextResponse } = await import('@ima-jin/fake-sdk');
console.log(NextResponse);
MJS

# --- Reproduce the bug: plain ESM import fails before shimming (#2383) ---
if node verify-import.mjs >/dev/null 2>verify-import.err; then
  echo "⚠️  the unshimmed import unexpectedly succeeded; the #2383 failure mode did not repro here (continuing to verify the fix regardless)"
else
  if grep -q "Cannot find module" verify-import.err; then
    echo "✅ reproduced the #2383 failure mode: plain-Node ESM import of a no-exports peer subpath fails"
  else
    echo "❌ import failed for an unexpected reason:"
    cat verify-import.err
    FAILURES=$((FAILURES + 1))
  fi
fi

# --- The fix: shim the peer's subpath, then the same import succeeds ---
node "$REPO_ROOT/scripts/lib/shim-esm-subpaths.mjs" "$WORKDIR/consumer" fake-next

check "shim file was created next to the peer's own subpath file" \
  test -f "$WORKDIR/consumer/node_modules/fake-next/server"
check "the previously-failing import now succeeds" \
  node verify-import.mjs
check "the import resolves the peer's real named export" \
  bash -c "node verify-import.mjs | grep -q fake-next-response"

if [[ "$FAILURES" -gt 0 ]]; then
  echo "$FAILURES assertion(s) failed."
  exit 1
fi
echo "All smoke-test-sdk-install ESM-shim assertions passed."
