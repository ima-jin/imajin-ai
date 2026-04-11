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

DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

LAST_SHA_FILE=".last-build-sha"
CURRENT_SHA=$(git rev-parse HEAD)

# Detect changed packages
if [[ -f "$LAST_SHA_FILE" ]]; then
  LAST_SHA=$(cat "$LAST_SHA_FILE")
  if [[ "$LAST_SHA" == "$CURRENT_SHA" ]]; then
    echo "✓ Already built at $(echo $CURRENT_SHA | cut -c1-7) — nothing to do"
    exit 0
  fi

  echo "Detecting changes since $(echo $LAST_SHA | cut -c1-7)..."
  CHANGED_APPS=$(pnpm --filter "...[${LAST_SHA}]" ls --depth -1 2>/dev/null \
    | grep -oP '(?<=/imajin-ai/)apps/\S+' \
    | sed 's|apps/||; s| .*||' \
    | sort -u || true)
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
  exit 0
fi

# Build via build.sh
./scripts/build.sh $APP_LIST

# Only stamp SHA if build.sh succeeded
echo "$CURRENT_SHA" > "$LAST_SHA_FILE"
