#!/bin/bash
# build-changed.sh — detect changed apps and pass them to build.sh
# Usage: ./scripts/build-changed.sh [--prod|--dev] [--dry-run]
#
# Detects which apps changed since the last successful build (via .last-build-sha),
# walks the pnpm dependency graph to catch transitive changes (e.g. packages/db
# changed → all apps that import it), then calls build.sh with the list.
#
# First run (no .last-build-sha): builds all apps.

set -euo pipefail
export NODE_ENV=production
cd "$(git rev-parse --show-toplevel)"

# is_app_stale APP
# Returns 0 (true) if the app's .next output is older than its source files,
# or if no .next/BUILD_ID exists. Excludes .next/ and node_modules/ from the
# source scan so the build output itself doesn't trigger re-detection.
is_app_stale() {
  local app="$1"
  local build_id="apps/$app/.next/BUILD_ID"
  # No BUILD_ID → definitely stale
  [[ ! -f "$build_id" ]] && return 0
  # Any source file newer than BUILD_ID → stale
  local stale
  stale=$(find "apps/$app" \
    \( -path "apps/$app/.next" -o -path "apps/$app/node_modules" \) -prune \
    -o -type f -newer "$build_id" -print \
    2>/dev/null | head -1)
  [[ -n "$stale" ]]
}

DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

LAST_SHA_FILE=".last-build-sha"
CURRENT_SHA=$(git rev-parse HEAD)

# Detect changed packages
if [[ -f "$LAST_SHA_FILE" ]]; then
  LAST_SHA=$(cat "$LAST_SHA_FILE")
  if [[ "$LAST_SHA" == "$CURRENT_SHA" ]]; then
    # SHA matches — check per-app .next freshness before declaring done.
    # This catches manual git-pull scenarios where source is newer than .next.
    STALE_APPS=""
    for _app in $(ls apps/*/package.json 2>/dev/null | cut -d/ -f2); do
      if is_app_stale "$_app"; then
        STALE_APPS+="$_app "
      fi
    done
    if [[ -z "$STALE_APPS" ]]; then
      echo "✓ Already built at $(echo $CURRENT_SHA | cut -c1-7) — nothing to do"
      exit 0
    fi
    echo "⚠️  SHA matches but stale .next detected for: $STALE_APPS"
    CHANGED_APPS=$(echo "$STALE_APPS" | tr ' ' '\n' | grep -v '^$' | sort -u)
  fi

  echo "Detecting changes since $(echo $LAST_SHA | cut -c1-7)..."

  # (1) Dependency-graph walk: catches transitive changes (packages/db changed →
  #     every app that imports it). This is the pnpm --filter "...[SHA]" set.
  GRAPH_APPS=$(pnpm --filter "...[${LAST_SHA}]" ls --depth -1 2>/dev/null \
    | grep -oP '(?<=/imajin-ai/)apps/\S+' \
    | sed 's|apps/||; s| .*||' \
    | sort -u || true)

  # (2) Direct path detection: catches an app whose OWN source changed but that the
  #     graph walk can miss (e.g. apps/kernel app-source edits that don't surface as a
  #     dependency-graph delta). Map any changed apps/<name>/** path → <name>.
  #     This is the fix for the stale-kernel / broken-MCP-connector bug (Day 170):
  #     build-changed.sh was skipping @imajin/kernel after kernel source changed.
  PATH_APPS=$(git diff --name-only "${LAST_SHA}" "${CURRENT_SHA}" 2>/dev/null \
    | grep -oP '^apps/[^/]+' \
    | sed 's|apps/||' \
    | sort -u || true)

  # UNION the two so a changed app is never dropped.
  CHANGED_APPS=$(printf '%s\n%s\n' "$GRAPH_APPS" "$PATH_APPS" | grep -v '^$' | sort -u || true)
else
  echo "No previous build SHA — all apps need building"
  CHANGED_APPS=$(ls apps/*/package.json 2>/dev/null | cut -d/ -f2)
fi

if [[ -z "$CHANGED_APPS" ]]; then
  echo "✓ No apps changed"
  echo "$CURRENT_SHA" > "$LAST_SHA_FILE"
  exit 0
fi

APP_LIST=$(echo "$CHANGED_APPS" | tr '\n' ' ')
COUNT=$(echo "$CHANGED_APPS" | wc -l)

echo ""
echo "$COUNT app(s) to build: $APP_LIST"

if $DRY_RUN; then
  echo "(dry run — would run: ./scripts/build.sh $APP_LIST)"
  echo ""
  echo "Per-app .next freshness:"
  for _app in $(ls apps/*/package.json 2>/dev/null | cut -d/ -f2); do
    if is_app_stale "$_app"; then
      echo "  $_app: STALE"
    else
      echo "  $_app: fresh"
    fi
  done
  exit 0
fi

# Build via build.sh
./scripts/build.sh $APP_LIST

# Only stamp SHA if build.sh succeeded
echo "$CURRENT_SHA" > "$LAST_SHA_FILE"
