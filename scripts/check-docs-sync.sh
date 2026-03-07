#!/usr/bin/env bash
# Verify that every app and package is documented in ENVIRONMENTS.md and README.md.
# Run in CI or locally: ./scripts/check-docs-sync.sh

set -euo pipefail

MISSING=0

echo "Checking apps..."
for dir in apps/*/; do
  name=$(basename "$dir")
  if ! grep -q "$name" docs/ENVIRONMENTS.md 2>/dev/null; then
    echo "  ❌ apps/$name missing from docs/ENVIRONMENTS.md"
    MISSING=1
  fi
  if ! grep -q "$name" README.md 2>/dev/null; then
    echo "  ❌ apps/$name missing from README.md"
    MISSING=1
  fi
done

echo "Checking packages..."
for dir in packages/*/; do
  name=$(basename "$dir")
  if ! grep -q "$name" docs/ENVIRONMENTS.md 2>/dev/null; then
    echo "  ❌ packages/$name missing from docs/ENVIRONMENTS.md"
    MISSING=1
  fi
  if ! grep -q "$name" README.md 2>/dev/null; then
    echo "  ❌ packages/$name missing from README.md"
    MISSING=1
  fi
done

if [ "$MISSING" -eq 0 ]; then
  echo "✅ All apps and packages are documented."
else
  echo ""
  echo "⚠️  Some apps/packages are not documented. Update docs/ENVIRONMENTS.md and README.md."
  exit 1
fi
