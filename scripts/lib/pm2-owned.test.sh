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
FAKE_PM2_HOME=""
trap 'rm -rf "$FAKE_BIN" "$FAKE_PM2_HOME"' EXIT

# Fake process tree for the tests below:
#   1 (init)
#   └─ 100 (pm2-managed: the pid pm2 jlist reports, e.g. `next start`)
#      └─ 200 (child pm2 doesn't know about directly, e.g. `next-server`)
#         └─ 201 (grandchild, still within the ancestor walk)
#   900 (unrelated process, parented directly to init — a true orphan)
#
# depth-limit tree: 300 -> 301 -> 302 -> 303 -> 304 -> 305 -> 306
# pid 300 is pm2-managed. is_pm2_owned checks the pid itself plus up to 5
# ancestors (6 checks total), so 305 (5 hops from 300) is the last pid still
# within the walk and 306 (6 hops) is the first pid that falls outside it.
#
# God-Daemon-fallback tree (#2344): 1156 is the PM2 God Daemon itself. 500 is
# a wrapper pm2 just spawned (a direct child of the daemon) that hasn't made
# it into our PM2_PIDS snapshot yet — e.g. pm2 respawned it between our last
# `pm2 jlist` and now. 501 is its grandchild (holds the port). Neither 500
# nor 501 is in the fake jlist below, so only the God-Daemon-ancestor signal
# can recognize them as owned.
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
  500) echo 1156 ;;
  501) echo 500 ;;
  *) echo 1 ;;
esac
EOF
chmod +x "$FAKE_BIN/ps"

cat > "$FAKE_BIN/pm2" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" = "jlist" ]]; then
  echo '[{"pid":100,"name":"prod-events","pm2_env":{"status":"online"}},{"pid":300,"name":"prod-www","pm2_env":{"status":"stopped"}}]'
fi
EOF
chmod +x "$FAKE_BIN/pm2"

if ! command -v node >/dev/null 2>&1; then
  echo "node not found on PATH — cannot run tests (pm2_managed_pids parses jlist with node)" >&2
  exit 1
fi

PATH="$FAKE_BIN:$PATH"
export PATH

# Isolate PM2_HOME so pm2_god_daemon_pid() reads our fake pm2.pid instead of
# any real ~/.pm2/pm2.pid on the machine running this test.
FAKE_PM2_HOME="$(mktemp -d "${TMPDIR:-/tmp}/pm2-owned-test-home.XXXXXX")"
PM2_HOME="$FAKE_PM2_HOME"
export PM2_HOME
echo 1156 > "$PM2_HOME/pm2.pid"

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
assert_not_owned "true orphan (not in jlist, ancestry never touches pm2 or the God Daemon) is reaped-eligible" 900
assert_owned "depth-limit: pid 5 hops from managed pid still within limit" 305
assert_not_owned "depth-limit: pid 6 hops from managed pid exceeds the walk" 306

# God-Daemon-ancestor fallback (#2344): 500/501 are NOT in the fake pm2
# jlist (simulating a stale PM2_PIDS snapshot right after a pm2 respawn),
# but 500 is a direct child of the God Daemon pid (1156, from our fake
# PM2_HOME/pm2.pid) and 501 is 500's grandchild. Both must still be
# recognized as pm2-owned so a genuinely healthy, merely-unlisted pm2
# process is never reaped.
assert_owned "God-Daemon fallback: direct child of the daemon, absent from jlist" 500
assert_owned "God-Daemon fallback: grandchild of an unlisted daemon child" 501

assert_online() {
  local desc="$1" name="$2"
  if pm2_app_is_online "$name"; then
    echo "✅ $desc"
  else
    echo "❌ $desc (expected online, got not-online) — name=$name"
    FAILURES=$((FAILURES + 1))
  fi
}

assert_not_online() {
  local desc="$1" name="$2"
  if pm2_app_is_online "$name"; then
    echo "❌ $desc (expected not-online, got online) — name=$name"
    FAILURES=$((FAILURES + 1))
  else
    echo "✅ $desc"
  fi
}

assert_online "pm2_app_is_online: matching name with status=online" "prod-events"
assert_not_online "pm2_app_is_online: matching name with status=stopped" "prod-www"
assert_not_online "pm2_app_is_online: name pm2 doesn't know about" "prod-nonexistent"

if [[ "$FAILURES" -gt 0 ]]; then
  echo "$FAILURES assertion(s) failed."
  exit 1
fi
echo "All pm2-owned.sh assertions passed."
