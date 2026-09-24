#!/usr/bin/env bash
# deploy-skip.test.sh — unit tests for scripts/lib/deploy-skip.sh (#2344).
#
# Usage: scripts/lib/deploy-skip.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

FAILURES=0

assert_skipped() {
  local desc="$1" app="$2"
  if is_skipped_service "$app"; then
    echo "✅ $desc"
  else
    echo "❌ $desc (expected skipped, got not-skipped) — app=$app"
    FAILURES=$((FAILURES + 1))
  fi
}

assert_not_skipped() {
  local desc="$1" app="$2"
  if is_skipped_service "$app"; then
    echo "❌ $desc (expected not-skipped, got skipped) — app=$app"
    FAILURES=$((FAILURES + 1))
  else
    echo "✅ $desc"
  fi
}

# Default list (no DEPLOY_SKIP_SERVICES override in the environment).
unset DEPLOY_SKIP_SERVICES 2>/dev/null || true
# shellcheck source=scripts/lib/deploy-skip.sh
source "$SCRIPT_DIR/deploy-skip.sh"

assert_skipped "corpus is skipped by default (runs on gx10, not this box)" "corpus"
assert_not_skipped "events is not skipped by default" "events"
assert_not_skipped "broker-agent is not skipped by default (already handled via its zero port)" "broker-agent"

# Env override replaces the default list entirely (space-separated).
DEPLOY_SKIP_SERVICES="broker-agent corpus"
assert_skipped "broker-agent honoured once added to an override list" "broker-agent"
assert_skipped "corpus still honoured alongside an override" "corpus"

DEPLOY_SKIP_SERVICES="events"
assert_skipped "override list honoured for a non-default entry" "events"
assert_not_skipped "corpus excluded once an override list replaces the default" "corpus"

if [[ "$FAILURES" -gt 0 ]]; then
  echo "$FAILURES assertion(s) failed."
  exit 1
fi
echo "All deploy-skip.sh assertions passed."
