#!/bin/bash
# Generate drizzle migrations for all (or specified) services.
#
# Usage: ./scripts/generate.sh [app1 app2 ...]
# If no apps specified, runs for all apps with drizzle.config.ts

set -e
export PATH=/home/jin/.nvm/versions/node/v22.22.0/bin:$PATH

BASE_DIR="$(cd "$(dirname "$0")/.." && pwd)"

APPS=("$@")
if [ ${#APPS[@]} -eq 0 ]; then
  for config in "$BASE_DIR"/apps/*/drizzle.config.ts; do
    app="$(basename "$(dirname "$config")")"
    APPS+=("$app")
  done
fi

CHANGED=()
UNCHANGED=()

for app in "${APPS[@]}"; do
  APP_DIR="$BASE_DIR/apps/$app"

  if [ ! -f "$APP_DIR/drizzle.config.ts" ]; then
    echo "⚠️  $app — no drizzle.config.ts, skipping"
    continue
  fi

  echo ""
  echo "=== Generating $app ==="
  cd "$APP_DIR"

  # Load DATABASE_URL from .env.local
  if [ -f .env.local ]; then
    _raw="$(grep '^DATABASE_URL=' .env.local | head -1 | cut -d= -f2-)"
    export DATABASE_URL="${_raw%\"}"
    DATABASE_URL="${DATABASE_URL#\"}"
  fi

  if [ -z "$DATABASE_URL" ]; then
    echo "⚠️  $app — DATABASE_URL not set, skipping"
    cd "$BASE_DIR"
    continue
  fi

  # Count SQL files before
  before=$(ls drizzle/*.sql 2>/dev/null | wc -l)

  npx drizzle-kit generate

  # Count SQL files after
  after=$(ls drizzle/*.sql 2>/dev/null | wc -l)

  if [ "$after" -gt "$before" ]; then
    CHANGED+=("$app")
    echo "📝 $app — new migration generated"
  else
    UNCHANGED+=("$app")
    echo "✅ $app — no changes"
  fi

  cd "$BASE_DIR"
done

echo ""
echo "📝 New migrations: ${CHANGED[*]:-none}"
echo "✅ No changes:     ${UNCHANGED[*]:-none}"
