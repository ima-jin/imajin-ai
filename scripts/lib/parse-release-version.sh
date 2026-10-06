#!/usr/bin/env bash
# parse-release-version.sh — extract the version from a release commit's first
# line (#2622). Sourced by .github/workflows/tag-release.yml and covered by
# scripts/__tests__/tag-release-parse.test.mjs.
#
# The release PR's commit message is `release: vX.Y.Z`, but a re-stamp after
# merging main into the release branch can leave trailing text, e.g.
# `release: v0.8.14 (re-stamp after main merge into release branch)`. Only the
# leading `vX.Y.Z` token is the version: anything may follow it, but only after
# whitespace, so `release: v0.8.14.1`, `release: v0.8.14-rc1` and `release: vfoo`
# are all rejected.
#
# Usage (sourced; deliberately does not `set -e`, so it is safe to source from
# any caller):
#   VERSION="$(parse_release_version "$FIRST_LINE")" || exit 1
#
# Prints the bare version (no leading `v`) on stdout and returns 0, or prints
# nothing and returns 1 when the line is not a well-formed release line.

parse_release_version() {
  local first_line="${1-}"
  local pattern='^release: v([0-9]+\.[0-9]+\.[0-9]+)([[:space:]]|$)'
  if [[ "$first_line" =~ $pattern ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
    return 0
  fi
  return 1
}
