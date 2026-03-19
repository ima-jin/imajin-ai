#!/bin/bash
# Run pending drizzle-kit migrations for all (or specified) services.
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

  echo ""
  echo "=== Migrating $app ==="
  cd "$APP_DIR"

  # Load DATABASE_URL from .env.local (grep instead of source — env files have unquoted special chars)
  if [ -f .env.local ]; then
    export DATABASE_URL="$(grep '^DATABASE_URL=' .env.local | head -1 | cut -d= -f2-)"
  else
    echo "⚠️  $app — no .env.local found, DATABASE_URL must already be set"
  fi

  if [ -z "$DATABASE_URL" ]; then
    echo "❌ $app — DATABASE_URL is not set, skipping"
    FAILED+=("$app")
    cd "$BASE_DIR"
    continue
  fi

  if npx drizzle-kit migrate; then
    SUCCEEDED+=("$app")
    echo "✅ $app"
  else
    FAILED+=("$app")
    echo "❌ $app — migration failed"
  fi

  cd "$BASE_DIR"
done

echo ""
echo "✅ Succeeded: ${SUCCEEDED[*]:-none}"
echo "❌ Failed:    ${FAILED[*]:-none}"

[ ${#FAILED[@]} -eq 0 ]
