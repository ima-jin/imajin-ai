#!/usr/bin/env bash
# pm2-owned.test.sh — unit tests for scripts/lib/pm2-owned.sh (#2237).
#
# No bats in this repo yet, so this fakes `ps` and `pm2` via PATH shims
# (a fake bin dir prepended to PATH) and asserts on is_pm2_owned's exit code.
#
# Usage: scripts/lib/pm2-owned.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/pm2-owned.sh
source "$SCRIPT_DIR/pm2-owned.sh"

FAKE_BIN="$(mktemp -d "${TMPDIR:-/tmp}/pm2-owned-test.XXXXXX")"
trap 'rm -rf "$FAKE_BIN"' EXIT

# Fake process tree for the tests below:
#   1 (init)
#   └─ 100 (pm2-managed: the pid pm2 jlist reports, e.g. `next start`)
#      └─ 200 (child pm2 doesn't know about directly, e.g. `next-server`)
#         └─ 201 (grandchild, still within the ancestor walk)
#   900 (unrelated process, parented directly to init)
#
# depth-limit tree: 300 -> 301 -> 302 -> 303 -> 304 -> 305 -> 306
# pid 300 is pm2-managed. is_pm2_owned checks the pid itself plus up to 5
# ancestors (6 checks total), so 305 (5 hops from 300) is the last pid still
# within the walk and 306 (6 hops) is the first pid that falls outside it.
cat > "$FAKE_BIN/ps" <<'EOF'
#!/usr/bin/env bash
# Fakes `ps -o ppid= -p <pid>`.
pid=""
for arg in "$@"; do
  case "$prev" in
    -p) pid="$arg" ;;
  esac
  prev="$arg"
done
case "$pid" in
  100) echo 1 ;;
  200) echo 100 ;;
  201) echo 200 ;;
  900) echo 1 ;;
  300) echo 1 ;;
  301) echo 300 ;;
  302) echo 301 ;;
  303) echo 302 ;;
  304) echo 303 ;;
  305) echo 304 ;;
  306) echo 305 ;;
  307) echo 306 ;;
  *) echo 1 ;;
esac
EOF
chmod +x "$FAKE_BIN/ps"

cat > "$FAKE_BIN/pm2" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" = "jlist" ]]; then
  echo '[{"pid":100},{"pid":300}]'
fi
EOF
chmod +x "$FAKE_BIN/pm2"

if ! command -v node >/dev/null 2>&1; then
  echo "node not found on PATH — cannot run tests (pm2_managed_pids parses jlist with node)" >&2
  exit 1
fi

PATH="$FAKE_BIN:$PATH"
export PATH

PM2_PIDS="$(pm2_managed_pids)"

FAILURES=0

assert_owned() {
  local desc="$1" pid="$2"
  if is_pm2_owned "$pid"; then
    echo "✅ $desc"
  else
    echo "❌ $desc (expected owned, got not-owned) — pid=$pid"
    FAILURES=$((FAILURES + 1))
  fi
}

assert_not_owned() {
  local desc="$1" pid="$2"
  if is_pm2_owned "$pid"; then
    echo "❌ $desc (expected not-owned, got owned) — pid=$pid"
    FAILURES=$((FAILURES + 1))
  else
    echo "✅ $desc"
  fi
}

assert_not_owned "sanity: PM2_PIDS populated from fake pm2 jlist" 999999
[[ "$PM2_PIDS" == *100* && "$PM2_PIDS" == *300* ]] || {
  echo "❌ PM2_PIDS did not contain expected pids: '$PM2_PIDS'"
  FAILURES=$((FAILURES + 1))
}

assert_owned "direct pid owned (exact match)" 100
assert_owned "child owned (ancestor walk, 1 hop)" 200
assert_owned "grandchild owned (ancestor walk, 2 hops)" 201
assert_not_owned "unrelated pid not owned" 900
assert_owned "depth-limit: pid 5 hops from managed pid still within limit" 305
assert_not_owned "depth-limit: pid 6 hops from managed pid exceeds the walk" 306

if [[ "$FAILURES" -gt 0 ]]; then
  echo "$FAILURES assertion(s) failed."
  exit 1
fi
echo "All pm2-owned.sh assertions passed."
