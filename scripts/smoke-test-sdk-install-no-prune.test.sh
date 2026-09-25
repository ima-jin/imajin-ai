#!/usr/bin/env bash
# smoke-test-sdk-install-no-prune.test.sh — regression test for #2380.
#
# scripts/smoke-test-sdk-install.sh installs the requested `@ima-jin/*`
# specs, then separately installs their declared peerDependencies, in the
# *same* scratch directory. The historical bug: both `npm install` calls
# used `--no-save`, so npm treated whichever call ran last as the entire
# desired tree for the (never-recorded) package.json and pruned everything
# the previous call had installed — the peers landed, the SDK packages did
# not.
#
# This can't exercise scripts/smoke-test-sdk-install.sh directly without a
# real GITHUB_PACKAGES_TOKEN and network access to GitHub Packages. What
# *is* testable without either is the actual npm mechanism the fix relies
# on: two sequential `npm install` calls, without `--no-save`, targeting two
# local `file:` packages (no registry involved at all) in the same
# directory. This reproduces the pruning with `--no-save` and proves it's
# gone once both calls save to package.json instead — the same fix applied
# to the real script.
#
# Usage: scripts/smoke-test-sdk-install-no-prune.test.sh
set -euo pipefail

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

# Two throwaway local packages standing in for two `@ima-jin/*` SDK
# packages — real content doesn't matter, only that npm treats them as two
# separate installable units.
mkdir -p "$WORKDIR/pkg-a" "$WORKDIR/pkg-b" "$WORKDIR/consumer"
cat >"$WORKDIR/pkg-a/package.json" <<'JSON'
{ "name": "smoke-test-pkg-a", "version": "1.0.0" }
JSON
cat >"$WORKDIR/pkg-b/package.json" <<'JSON'
{ "name": "smoke-test-pkg-b", "version": "1.0.0" }
JSON

cd "$WORKDIR/consumer"
npm init -y >/dev/null

# --- Reproduce the bug: two `--no-save` installs in the same directory ---
npm install --no-save --no-audit --no-fund --ignore-scripts "file:../pkg-a" >/dev/null
check "sanity: pkg-a is present after the first --no-save install" \
  test -f node_modules/smoke-test-pkg-a/package.json

npm install --no-save --no-audit --no-fund --ignore-scripts "file:../pkg-b" >/dev/null
if [[ -f node_modules/smoke-test-pkg-a/package.json ]]; then
  echo "⚠️  pkg-a survived a second --no-save install on this npm version; the #2380 failure mode did not repro here (continuing to verify the fix regardless)"
else
  echo "✅ reproduced the #2380 failure mode: an unsaved second install pruned the first"
fi

# --- The fix: install both without --no-save (#2380) ---
rm -rf node_modules package-lock.json
npm install --no-audit --no-fund --ignore-scripts "file:../pkg-a" >/dev/null
npm install --no-audit --no-fund --ignore-scripts "file:../pkg-b" >/dev/null

check "pkg-a survives the second install once both installs are saved (#2380 fix)" \
  test -f node_modules/smoke-test-pkg-a/package.json
check "pkg-b is also present" \
  test -f node_modules/smoke-test-pkg-b/package.json
check "package.json now records both phases" \
  grep -q "smoke-test-pkg-a" package.json
check "package.json records the second phase too" \
  grep -q "smoke-test-pkg-b" package.json

if [[ "$FAILURES" -gt 0 ]]; then
  echo "$FAILURES assertion(s) failed."
  exit 1
fi
echo "All smoke-test-sdk-install no-prune assertions passed."
