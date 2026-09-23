#!/usr/bin/env bash
# build-version.test.sh — unit tests for scripts/lib/build-version.sh (#2285, #2287).
#
# No bats in this repo yet (see pm2-owned.test.sh) — this constructs real
# temp git repos and asserts on compute_git_tag_version's stdout.
#
# Usage: scripts/lib/build-version.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/build-version.sh
source "$SCRIPT_DIR/build-version.sh"

FAILURES=0

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    echo "✅ $desc"
  else
    echo "❌ $desc (expected '$expected', got '$actual')"
    FAILURES=$((FAILURES + 1))
  fi
}

make_repo() {
  local dir
  dir="$(mktemp -d "${TMPDIR:-/tmp}/build-version-test.XXXXXX")"
  git -C "$dir" init -q
  git -C "$dir" config user.email test@example.com
  git -C "$dir" config user.name Test
  echo '{"name":"x","version":"0.5.0"}' > "$dir/package.json"
  git -C "$dir" add -A
  git -C "$dir" commit -q -m init
  echo "$dir"
}

# --- Test 1: a plain version-tagged checkout resolves that tag -------------
DIR1="$(make_repo)"
git -C "$DIR1" tag v0.8.0
echo extra >> "$DIR1/package.json"
git -C "$DIR1" add -A
git -C "$DIR1" commit -q -m more
VERSION1="$(cd "$DIR1" && compute_git_tag_version)"
assert_eq "resolves the nearest reachable version tag" "0.8.0" "$VERSION1"
rm -rf "$DIR1"

# --- Test 2 (#2287 regression): a later NON-version tag must not win ------
DIR2="$(make_repo)"
git -C "$DIR2" tag v0.8.0
echo extra >> "$DIR2/package.json"
git -C "$DIR2" add -A
git -C "$DIR2" commit -q -m more
# A marker/checkpoint tag created AFTER the release tag, on a later commit —
# without --match 'v[0-9]*' this is exactly what would hijack the footer.
git -C "$DIR2" tag checkpoint-2026-09
echo more >> "$DIR2/package.json"
git -C "$DIR2" add -A
git -C "$DIR2" commit -q -m "even more"
VERSION2="$(cd "$DIR2" && compute_git_tag_version)"
assert_eq "ignores a later non-version tag and still resolves the version tag" "0.8.0" "$VERSION2"
rm -rf "$DIR2"

# --- Test 3: an untagged checkout resolves to nothing (caller falls back) -
DIR3="$(make_repo)"
VERSION3="$(cd "$DIR3" && compute_git_tag_version)"
assert_eq "untagged checkout resolves to empty (falls back to package.json)" "" "$VERSION3"
rm -rf "$DIR3"

# --- Test 4: a repo with ONLY a non-version tag also resolves to nothing --
DIR4="$(make_repo)"
git -C "$DIR4" tag latest
VERSION4="$(cd "$DIR4" && compute_git_tag_version)"
assert_eq "a repo with only a non-version tag resolves to empty" "" "$VERSION4"
rm -rf "$DIR4"

if [[ "$FAILURES" -gt 0 ]]; then
  echo "$FAILURES assertion(s) failed."
  exit 1
fi
echo "All build-version.sh assertions passed."
