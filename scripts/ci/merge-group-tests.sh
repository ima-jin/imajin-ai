#!/bin/bash
# Root Vitest + Turbo's affected package graph, without coverage or e2e.
# No package-local test script assumptions: many workspaces have none.
set -euo pipefail

cd "$(dirname "$0")/../.."
BASE_SHA="${MERGE_GROUP_BASE_SHA:?merge_group.base_sha is required}"
if [[ ! "$BASE_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  printf '%s\n' 'Invalid merge-group base SHA' >&2
  exit 1
fi
git cat-file -e "${BASE_SHA}^{commit}"

PLAN=$(mktemp)
DIRECTORIES=$(mktemp)
trap 'rm -f "$PLAN" "$DIRECTORIES"' EXIT

# The leading ... includes dependents of changed packages, not just files
# modified in this entry. Fail closed if Turbo or JSON parsing fails.
pnpm exec turbo ls --filter="...[$BASE_SHA]" --output=json > "$PLAN"
node --input-type=module - "$PLAN" > "$DIRECTORIES" <<'JS'
import { readFileSync } from 'node:fs';
const plan = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (!Array.isArray(plan.packages?.items)) throw new Error('Invalid Turbo package list');
for (const { path } of plan.packages.items) {
  if (!/^(apps|packages)\/[a-zA-Z0-9_-]+$/.test(path)) {
    throw new Error(`Unexpected workspace path: ${path}`);
  }
  // Vitest positional filters are substring matches; trailing / prevents
  // packages/auth from also selecting packages/auth-client.
  console.log(`${path}/`);
}
JS

mapfile -t FILTERS < "$DIRECTORIES"
# Repo-level regression tests matter when their implementation/config changes.
# Workspace tests are already selected by Turbo, including shared dependents.
git diff --name-only "$BASE_SHA" HEAD -- scripts vitest.config.ts package.json pnpm-lock.yaml > "$PLAN"
if [[ -s "$PLAN" ]]; then
  FILTERS+=("scripts/__tests__/")
fi
if [[ ${#FILTERS[@]} -eq 0 ]]; then
  printf '%s\n' 'No affected unit-test directories.'
  exit 0
fi

printf 'Affected unit-test directory: %s\n' "${FILTERS[@]}"
pnpm exec vitest run "${FILTERS[@]}" --passWithNoTests \
  --exclude '**/e2e/**' --exclude '**/*.e2e.*' --exclude '**/*-e2e.*'
