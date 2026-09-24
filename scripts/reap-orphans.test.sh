#!/usr/bin/env bash
# reap-orphans.test.sh — end-to-end coverage for scripts/reap-orphans.sh (#2344).
#
# Runs the real script (not just the shared lib) with `ss`, `pm2`, `ps`,
# `kill`, and `sleep` faked via a PATH shim, so we can assert on its actual
# behavior: a genuine orphan gets killed, and a pm2 grandchild (recognized
# either via `pm2 jlist` or the God-Daemon-ancestor fallback) is left alone.
#
# Usage: scripts/reap-orphans.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REAP_SCRIPT="$SCRIPT_DIR/reap-orphans.sh"

FAKE_BIN="$(mktemp -d "${TMPDIR:-/tmp}/reap-orphans-test.XXXXXX")"
FAKE_PM2_HOME="$(mktemp -d "${TMPDIR:-/tmp}/reap-orphans-test-home.XXXXXX")"
KILL_LOG="$(mktemp "${TMPDIR:-/tmp}/reap-orphans-test-kills.XXXXXX")"
trap 'rm -rf "$FAKE_BIN" "$FAKE_PM2_HOME"; rm -f "$KILL_LOG"' EXIT

echo 1156 > "$FAKE_PM2_HOME/pm2.pid"

# Scenario wired into the fixed prod port list (scripts/reap-orphans.sh):
#   :7006 (events)  -> pid 9001, a TRUE orphan (parented to init) — must be reaped.
#   :7100 (coffee)  -> pid 9002, a pm2-managed grandchild (jlist reports the
#                      wrapper pid 9010; 9002's parent is 9010) — must NOT be reaped.
#   :7101 (dykil)   -> pid 9003, a direct child of the PM2 God Daemon (1156)
#                      that ISN'T in the fake jlist (simulating a stale-list
#                      respawn race, #2344) — must NOT be reaped either.
# All other managed ports report no listener.
cat > "$FAKE_BIN/ss" <<'EOF'
#!/usr/bin/env bash
# Fakes `ss -ltnpH "sport = :<port>"`.
port_arg="$*"
case "$port_arg" in
  *":7006"*) echo "LISTEN 0 511 *:7006 *:* users:((\"orphan\",pid=9001,fd=3))" ;;
  *":7100"*) echo "LISTEN 0 511 *:7100 *:* users:((\"next-server\",pid=9002,fd=3))" ;;
  *":7101"*) echo "LISTEN 0 511 *:7101 *:* users:((\"next-server\",pid=9003,fd=3))" ;;
esac
EOF
chmod +x "$FAKE_BIN/ss"

cat > "$FAKE_BIN/ps" <<'EOF'
#!/usr/bin/env bash
mode=""
pid=""
for arg in "$@"; do
  case "$prev" in
    -p) pid="$arg" ;;
  esac
  case "$arg" in
    -o) : ;;
    ppid=) mode="ppid" ;;
    cmd=) mode="cmd" ;;
  esac
  prev="$arg"
done
if [[ "$mode" = "ppid" ]]; then
  case "$pid" in
    9001) echo 1 ;;      # true orphan -> init
    9002) echo 9010 ;;   # pm2 grandchild -> pm2-tracked wrapper
    9010) echo 1156 ;;   # wrapper -> God Daemon
    9003) echo 1156 ;;   # direct daemon child, absent from jlist
    *) echo 1 ;;
  esac
else
  echo "fake-cmd-for-$pid"
fi
EOF
chmod +x "$FAKE_BIN/ps"

cat > "$FAKE_BIN/pm2" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" = "jlist" ]]; then
  echo '[{"pid":9010,"name":"prod-coffee","pm2_env":{"status":"online"}}]'
fi
EOF
chmod +x "$FAKE_BIN/pm2"

# Record every pid `kill` is asked to signal instead of actually signaling
# anything, and report that the target is already gone on the `kill -0`
# liveness recheck so the script doesn't fall through to a SIGKILL branch
# that would try (and fail) to signal a made-up pid a second time.
cat > "$FAKE_BIN/kill" <<EOF
#!/usr/bin/env bash
for arg in "\$@"; do
  case "\$arg" in
    -*) ;;
    *) echo "\$arg" >> "$KILL_LOG" ;;
  esac
done
if [[ "\$1" = "-0" ]]; then
  exit 1
fi
exit 0
EOF
chmod +x "$FAKE_BIN/kill"

# No real 2s/0.5s waits in a test.
cat > "$FAKE_BIN/sleep" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$FAKE_BIN/sleep"

if ! command -v node >/dev/null 2>&1; then
  echo "node not found on PATH — cannot run tests (pm2_managed_pids parses jlist with node)" >&2
  exit 1
fi

PATH="$FAKE_BIN:$PATH"
export PATH
PM2_HOME="$FAKE_PM2_HOME"
export PM2_HOME

# `kill` is a bash builtin that takes precedence over PATH lookups, so the
# fake $FAKE_BIN/kill above would silently be ignored by a plain `bash
# "$REAP_SCRIPT"` invocation. `enable -n kill` disables the builtin for this
# throwaway shell so reap-orphans.sh's bare `kill` calls actually resolve to
# our shim; sourcing (rather than exec'ing) the script keeps that override
# in effect for its whole run.
OUTPUT="$(bash -c 'enable -n kill; source "$1" "${@:2}"' _ "$REAP_SCRIPT" prod)"
echo "$OUTPUT"

FAILURES=0

if grep -qx "9001" "$KILL_LOG"; then
  echo "✅ true orphan (pid 9001, :7006) was reaped"
else
  echo "❌ true orphan (pid 9001, :7006) was NOT reaped"
  FAILURES=$((FAILURES + 1))
fi

if grep -qx "9002" "$KILL_LOG"; then
  echo "❌ pm2 grandchild (pid 9002, :7100, via jlist) was incorrectly reaped"
  FAILURES=$((FAILURES + 1))
else
  echo "✅ pm2 grandchild (pid 9002, :7100, via jlist) was left alone"
fi

if grep -qx "9003" "$KILL_LOG"; then
  echo "❌ God-Daemon-owned pid (pid 9003, :7101, absent from jlist) was incorrectly reaped"
  FAILURES=$((FAILURES + 1))
else
  echo "✅ God-Daemon-owned pid (pid 9003, :7101, absent from jlist) was left alone"
fi

if [[ "$FAILURES" -gt 0 ]]; then
  echo "$FAILURES assertion(s) failed."
  exit 1
fi
echo "All reap-orphans.sh end-to-end assertions passed."
