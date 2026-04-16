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

if [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "❌ No migrations/ directory found"
  exit 1
fi

FILES=($(ls "$MIGRATIONS_DIR"/*.sql 2>/dev/null | sort))
COUNT=${#FILES[@]}

if [ "$COUNT" -eq 0 ]; then
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
  [ -z "$NUM" ] && NUM=0

  # Check for gaps
  EXPECTED=$((PREV_NUM + 1))
  if [ "$PREV_NUM" -ge 0 ] && [ "$NUM" -ne "$EXPECTED" ]; then
    echo "⚠️  $basename: gap in numbering (expected $(printf '%04d' $EXPECTED))"
  fi
  PREV_NUM=$NUM

  # Check non-empty
  if [ ! -s "$file" ]; then
    echo "❌ $basename: empty file"
    FAILED=1
    continue
  fi

  echo "✅ $basename"
done

if [ "$FAILED" -eq 1 ]; then
  echo ""
  echo "Migration file issues found!"
  exit 1
fi

echo ""
echo "All $COUNT migration file(s) valid."
