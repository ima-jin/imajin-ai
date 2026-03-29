#!/bin/bash
# Verify drizzle migration consistency: every .sql file must have a
# corresponding journal entry and snapshot file.
#
# Usage: ./scripts/check-migrations.sh
# Returns non-zero if any service has mismatched migration artifacts.

set -e

BASE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
FAILED=0

for drizzle_dir in "$BASE_DIR"/apps/*/drizzle; do
  [ -d "$drizzle_dir" ] || continue
  service="$(basename "$(dirname "$drizzle_dir")")"
  meta_dir="$drizzle_dir/meta"
  journal="$meta_dir/_journal.json"

  sql_files=($(ls "$drizzle_dir"/*.sql 2>/dev/null))
  sql_count=${#sql_files[@]}

  if [ ! -f "$journal" ]; then
    if [ "$sql_count" -gt 0 ]; then
      echo "❌ $service: $sql_count SQL files but no _journal.json"
      FAILED=1
    fi
    continue
  fi

  journal_count=$(node -e "const j=JSON.parse(require('fs').readFileSync('$journal','utf8')); console.log(j.entries.length)")
  snapshot_count=$(ls "$meta_dir"/????_snapshot.json 2>/dev/null | wc -l)

  errors=()

  if [ "$sql_count" != "$journal_count" ]; then
    errors+=("sql=$sql_count but journal=$journal_count")
  fi

  if [ "$sql_count" != "$snapshot_count" ]; then
    errors+=("sql=$sql_count but snapshots=$snapshot_count")
  fi

  # Check each SQL file has a matching journal tag
  for sql_file in "${sql_files[@]}"; do
    tag="$(basename "$sql_file" .sql)"
    if ! node -e "const j=JSON.parse(require('fs').readFileSync('$journal','utf8')); process.exit(j.entries.some(e=>e.tag==='$tag') ? 0 : 1)" 2>/dev/null; then
      errors+=("$tag.sql has no journal entry")
    fi
  done

  if [ ${#errors[@]} -gt 0 ]; then
    echo "❌ $service: ${errors[*]}"
    FAILED=1
  else
    echo "✅ $service: $sql_count migrations"
  fi
done

if [ "$FAILED" -eq 1 ]; then
  echo ""
  echo "Migration artifacts are inconsistent!"
  echo "Did you hand-write a .sql file instead of running 'drizzle-kit generate'?"
  echo "Every migration needs: .sql file + journal entry + snapshot file."
  exit 1
fi

echo ""
echo "All migration artifacts consistent."
