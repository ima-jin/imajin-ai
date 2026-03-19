#!/bin/bash
# One-time baseline setup for drizzle-kit migrations.
# Run this on the server (where DATABASE_URL is available) for each environment.
#
# Usage: ./scripts/drizzle-baseline.sh [app1 app2 ...]
# If no apps specified, runs for all apps with drizzle.config.ts
#
# What it does:
#   1. drizzle-kit pull — introspects the live DB and writes snapshot to ./drizzle/meta/
#   2. drizzle-kit generate — diffs schema.ts against the snapshot; should produce nothing
#      if schema.ts matches the DB. Any migration produced here means DRIFT.

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

for app in "${APPS[@]}"; do
  APP_DIR="$BASE_DIR/apps/$app"

  if [ ! -f "$APP_DIR/drizzle.config.ts" ]; then
    echo "⚠️  $app — no drizzle.config.ts, skipping"
    continue
  fi

  echo ""
  echo "=== Baselining $app ==="
  cd "$APP_DIR"

  # Load DATABASE_URL from .env.local
  if [ -f .env.local ]; then
    set -a; source .env.local; set +a
  else
    echo "⚠️  $app — no .env.local found, DATABASE_URL must already be set"
  fi

  if [ -z "$DATABASE_URL" ]; then
    echo "❌ $app — DATABASE_URL is not set, skipping"
    FAILED+=("$app")
    cd "$BASE_DIR"
    continue
  fi

  # Step 1: Pull current DB state to establish snapshot
  echo "→ Running drizzle-kit pull..."
  if ! npx drizzle-kit pull; then
    echo "❌ $app — drizzle-kit pull failed"
    FAILED+=("$app")
    cd "$BASE_DIR"
    continue
  fi

  # Step 2: Generate — should produce nothing if schema.ts matches DB
  echo "→ Running drizzle-kit generate (drift check)..."
  GENERATE_OUTPUT=$(npx drizzle-kit generate 2>&1)
  echo "$GENERATE_OUTPUT"

  if echo "$GENERATE_OUTPUT" | grep -q "No schema changes"; then
    echo "✅ $app — no drift detected"
  elif echo "$GENERATE_OUTPUT" | grep -q "Everything's fine"; then
    echo "✅ $app — no drift detected"
  else
    echo "⚠️  $app — drift detected! Review the generated migration above."
    echo "   This means schema.ts does not match the live DB."
  fi

  cd "$BASE_DIR"
done

echo ""
if [ ${#FAILED[@]} -gt 0 ]; then
  echo "❌ Failed: ${FAILED[*]}"
  exit 1
else
  echo "✅ Baseline complete for: ${APPS[*]}"
fi
