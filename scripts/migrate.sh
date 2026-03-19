#!/bin/bash
# Run pending drizzle migrations for all (or specified) services.
#
# Uses per-service migration tables (__drizzle_migrations_<app>) so that
# services sharing the same database don't interfere with each other.
#
# Usage: ./scripts/migrate.sh [app1 app2 ...]
# If no apps specified, runs for all apps with drizzle.config.ts

set -e
export PATH=/home/jin/.nvm/versions/node/v22.22.0/bin:$PATH

BASE_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Collect target apps
APPS=("$@")
if [ ${#APPS[@]} -eq 0 ]; then
  for config in "$BASE_DIR"/apps/*/drizzle.config.ts; do
    app="$(basename "$(dirname "$config")")"
    APPS+=("$app")
  done
fi

FAILED=()
SUCCEEDED=()

for app in "${APPS[@]}"; do
  APP_DIR="$BASE_DIR/apps/$app"

  if [ ! -f "$APP_DIR/drizzle.config.ts" ]; then
    echo "⚠️  $app — no drizzle.config.ts, skipping"
    continue
  fi

  if [ ! -d "$APP_DIR/drizzle" ]; then
    echo "⚠️  $app — no drizzle/ directory, skipping"
    continue
  fi

  if pnpm --filter "$app" exec node "$BASE_DIR/scripts/migrate-service.mjs" "$app"; then
    SUCCEEDED+=("$app")
  else
    FAILED+=("$app")
  fi
done

echo ""
echo "✅ Succeeded: ${SUCCEEDED[*]:-none}"
echo "❌ Failed:    ${FAILED[*]:-none}"

[ ${#FAILED[@]} -eq 0 ]
