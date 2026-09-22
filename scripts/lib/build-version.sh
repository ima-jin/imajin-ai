#!/usr/bin/env bash
# build-version.sh — shared git-tag-version derivation for scripts/build.sh (#2285, #2287).
#
# Extracted into its own sourceable file (same pattern as pm2-owned.sh) so it
# can be unit-tested against constructed git repos without having to run all
# of build.sh's build/migrate/pm2 side effects.
#
# ## Why --match 'v[0-9]*' (#2287)
#
# `git describe --tags --abbrev=0` with no --match considers EVERY tag
# reachable from HEAD, not just release tags. A future non-version tag (a
# marker, a checkpoint, a snapshot label — anything not shaped like `vX.Y.Z`)
# created after the last real release would silently "win" and get rendered
# in the build footer instead of the actual release version. `--match
# 'v[0-9]*'` restricts consideration to tags that look like a version
# (`v` followed by a digit), which is the only shape
# .github/workflows/tag-release.yml ever creates.
#
# Usage (source, don't execute):
#   source "$(dirname "$0")/lib/build-version.sh"
#   GIT_TAG_VERSION="$(compute_git_tag_version)"

# Prints the nearest reachable vX.Y.Z tag's version (leading "v" stripped),
# or nothing if no such tag is reachable from HEAD. Never aborts the caller:
# `git describe` exits 128 when no matching tag exists at all, and the
# trailing `|| true` absorbs that so a caller running under `set -e`/
# `pipefail` (as this file's own test does) doesn't get torn down by an
# expected "no tag yet" outcome.
compute_git_tag_version() {
  git describe --tags --abbrev=0 --match 'v[0-9]*' 2>/dev/null | sed 's/^v//' || true
}
