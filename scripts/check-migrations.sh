#!/bin/bash
# Verify migration file consistency:
# - All files in migrations/ are sequentially numbered
# - All files are valid SQL (non-empty)
# - No gaps in numbering
#
# Usage: ./scripts/check-migrations.sh

set -e

BASE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MIGRATIONS_DIR="$BASE_DIR/migrations"
FAILED=0

if [[ ! -d "$MIGRATIONS_DIR" ]]; then
  echo "❌ No migrations/ directory found"
  exit 1
fi

# Guard against orphan migrations in per-app folders (the unified runner only
# scans migrations/ at repo root). See migrations/0015-0018 for what happens
# when this drifts.
ORPHANS=$(find "$BASE_DIR/apps" -path '*/node_modules' -prune -o \
  \( -path '*/migrations/*.sql' -o -path '*/src/db/migrations/*.sql' \) -print 2>/dev/null)
if [[ -n "$ORPHANS" ]]; then
  echo "❌ Orphan migration files outside root migrations/:"
  echo "$ORPHANS" | sed 's/^/   /'
  echo ""
  echo "Move these to migrations/NNNN_description.sql so scripts/migrate.mjs picks them up."
  echo "Per-app drizzle/ folders are scratch space only — never the source of truth."
  exit 1
fi

FILES=($(ls "$MIGRATIONS_DIR"/*.sql 2>/dev/null | sort))
COUNT=${#FILES[@]}

if [[ "$COUNT" -eq 0 ]]; then
  echo "⚠️  No migration files found"
  exit 0
fi

echo "Checking $COUNT migration file(s)..."

PREV_NUM=-1
for file in "${FILES[@]}"; do
  basename="$(basename "$file")"

  # Check naming format: NNNN_description.sql
  if ! echo "$basename" | grep -qP '^\d{4}_\S+\.sql$'; then
    echo "❌ $basename: invalid naming format (expected NNNN_description.sql)"
    FAILED=1
    continue
  fi

  # Extract number
  NUM=$(echo "$basename" | grep -oP '^\d+' | sed 's/^0*//' )
  [[ -z "$NUM" ]] && NUM=0

  # Check for duplicate numbers — HARD FAIL. Two files sharing a number is
  # never intentional and sort order decides apply order (see the 0068
  # inference collision: attestation_signatures sorted before the engine
  # migration that creates the schema it ALTERs → deploy broke).
  if [[ "$NUM" -eq "$PREV_NUM" ]]; then
    echo "❌ $basename: duplicate migration number $(printf '%04d' $NUM) (collides with previous file)"
    FAILED=1
    PREV_NUM=$NUM
    continue
  fi

  # Check for gaps
  EXPECTED=$((PREV_NUM + 1))
  if [[ "$PREV_NUM" -ge 0 ]] && [[ "$NUM" -ne "$EXPECTED" ]]; then
    echo "⚠️  $basename: gap in numbering (expected $(printf '%04d' $EXPECTED))"
  fi
  PREV_NUM=$NUM

  # Check non-empty
  if [[ ! -s "$file" ]]; then
    echo "❌ $basename: empty file"
    FAILED=1
    continue
  fi

  echo "✅ $basename"
done

if [[ "$FAILED" -eq 1 ]]; then
  echo ""
  echo "Migration file issues found!"
  exit 1
fi

echo ""
echo "All $COUNT migration file(s) valid."
