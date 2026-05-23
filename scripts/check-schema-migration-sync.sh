#!/bin/bash
# Fail if any drizzle schema.ts file changed without a new migration in the same PR/commit range.
# Override: include 'migration-not-required: <reason>' in any commit body in the range.
#
# Usage:
#   scripts/check-schema-migration-sync.sh [BASE_REF]
#   BASE_REF defaults to origin/main
#
# In CI: BASE_REF should be the PR's merge base.
# Pre-commit: caller should pass HEAD against pre-commit staged diff (see .husky/pre-commit).

set -e
BASE_REF="${1:-origin/main}"

# Files that count as schema changes
SCHEMA_PATTERN='(apps/.*/src/db/schema\.ts|packages/db/src/.*\.ts)$'

CHANGED_SCHEMA=$(git diff --name-only "$BASE_REF"...HEAD 2>/dev/null \
  | grep -E "$SCHEMA_PATTERN" || true)

NEW_MIGRATIONS=$(git diff --name-only --diff-filter=A "$BASE_REF"...HEAD 2>/dev/null \
  | grep -E '^migrations/[0-9]{4}_.*\.sql$' || true)

OVERRIDE=$(git log "$BASE_REF"..HEAD --format=%B 2>/dev/null \
  | grep -E '^migration-not-required:' || true)

if [[ -n "$CHANGED_SCHEMA" ]] && [[ -z "$NEW_MIGRATIONS" ]] && [[ -z "$OVERRIDE" ]]; then
  echo "❌ Schema files changed without a new migration:"
  echo "$CHANGED_SCHEMA" | sed 's/^/   /'
  NEXT=$(printf '%04d' $(( $(ls migrations/*.sql 2>/dev/null | grep -oP '\K\d{4}' | sort -n | tail -1 || echo 0) + 1 )))
  echo ""
  echo "Create: migrations/${NEXT}_<description>.sql"
  echo "Or add 'migration-not-required: <reason>' to a commit body in this PR if truly not needed."
  exit 1
fi

echo "✅ schema/migration sync check passed"
