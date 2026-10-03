#!/usr/bin/env bash
# assert-pm2-listeners.test.sh — end-to-end coverage for
# scripts/assert-pm2-listeners.sh (#2447).
#
# Runs the real script with `ss`, `pm2`, `ps` and `sleep` faked via a PATH
# shim and a synthetic ecosystem file, asserting that:
#   - a listener that IS the pm2 pid, or a descendant of it, passes;
#   - the exact #2447 incident (orphan next-server reparented to init holding
#     the port while pm2 owns a different pid) fails the deploy;
#   - a port with no listener fails; an app pm2 doesn't know is skipped.
#
# Usage: scripts/assert-pm2-listeners.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ASSERT_SCRIPT="$SCRIPT_DIR/assert-pm2-listeners.sh"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/assert-pm2-listeners-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
FAKE_BIN="$WORK/bin"
mkdir -p "$FAKE_BIN"

if ! command -v node >/dev/null 2>&1; then
  echo "node not found on PATH — cannot run tests" >&2
  exit 1
fi

# Healthy apps:
#   t-direct :7001  pm2 pid 100 is itself the listener (fork-mode exec of next)
#   t-child  :7002  pm2 pid 200, listener 201 is its child
#   t-args   :7003  port only declared via args "-p 7003"; pm2 pid 300 listens
# Unhealthy apps (each used in its own scenario):
#   t-orphan :7004  pm2 pid 400 but listener 999 is parented to init  (#2447)
#   t-silent :7005  pm2 pid 500 but nothing listens
#   t-unknown:7006  not known to pm2 at all -> skipped
cat > "$WORK/eco-ok.config.js" <<'EOF'
module.exports = { apps: [
  { name: 't-direct', env: { PORT: 7001 } },
  { name: 't-child', env: { PORT: 7002 } },
  { name: 't-args', args: 'start -p 7003' },
  { name: 't-unknown', env: { PORT: 7006 } },
  { name: 't-noport' },
] };
EOF
cat > "$WORK/eco-orphan.config.js" <<'EOF'
module.exports = { apps: [
  { name: 't-direct', env: { PORT: 7001 } },
  { name: 't-orphan', env: { PORT: 7004 } },
] };
EOF
cat > "$WORK/eco-silent.config.js" <<'EOF'
module.exports = { apps: [
  { name: 't-silent', env: { PORT: 7005 } },
] };
EOF

cat > "$FAKE_BIN/pm2" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" = "jlist" ]]; then
  echo '[{"pid":100,"name":"t-direct"},{"pid":200,"name":"t-child"},{"pid":300,"name":"t-args"},{"pid":400,"name":"t-orphan"},{"pid":500,"name":"t-silent"}]'
fi
EOF

cat > "$FAKE_BIN/ss" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *":7001"*) echo 'LISTEN 0 511 *:7001 *:* users:(("next",pid=100,fd=3))' ;;
  *":7002"*) echo 'LISTEN 0 511 *:7002 *:* users:(("next-server",pid=201,fd=3))' ;;
  *":7003"*) echo 'LISTEN 0 511 *:7003 *:* users:(("next",pid=300,fd=3))' ;;
  *":7004"*) echo 'LISTEN 0 511 *:7004 *:* users:(("next-server",pid=999,fd=3))' ;;
esac
EOF

cat > "$FAKE_BIN/ps" <<'EOF'
#!/usr/bin/env bash
pid=""
prev=""
for arg in "$@"; do
  [[ "$prev" = "-p" ]] && pid="$arg"
  prev="$arg"
done
case "$pid" in
  201) echo 200 ;;
  *) echo 1 ;;
esac
EOF

# No real waits in a test.
cat > "$FAKE_BIN/sleep" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$FAKE_BIN"/*

PATH="$FAKE_BIN:$PATH"
export PATH
export ASSERT_TIMEOUT=2 ASSERT_INTERVAL=1

FAILURES=0

# run_case <label> <expected-exit> <ecosystem> [expected-output-substring...]
run_case() {
  local label="$1" expected="$2" eco="$3" out status=0
  shift 3
  out="$(bash "$ASSERT_SCRIPT" prod "$WORK/$eco" 2>&1)" || status=$?
  echo "$out"
  if [[ "$status" -ne "$expected" ]]; then
    echo "❌ $label: expected exit $expected, got $status"
    FAILURES=$((FAILURES + 1))
    return
  fi
  local needle
  for needle in "$@"; do
    if ! grep -qF -- "$needle" <<< "$out"; then
      echo "❌ $label: output is missing '$needle'"
      FAILURES=$((FAILURES + 1))
      return
    fi
  done
  echo "✅ $label"
}

run_case "healthy listeners (direct, child, -p args) pass; unknown app skipped" 0 eco-ok.config.js \
  "t-direct :7001" "t-child :7002" "t-args :7003" "t-unknown not known to pm2" "all 3 checked"
run_case "orphan next-server holding the port fails the deploy (#2447)" 1 eco-orphan.config.js \
  "listener pid 999 on :7004 is not a child of pm2 pid 400" "1 of 2"
run_case "pm2 app with no listener fails" 1 eco-silent.config.js \
  "nothing is listening on :7005"

status=0
bash "$ASSERT_SCRIPT" bogus >/dev/null 2>&1 || status=$?
if [[ "$status" -eq 2 ]]; then
  echo "✅ unknown scope exits 2"
else
  echo "❌ unknown scope: expected exit 2, got $status"
  FAILURES=$((FAILURES + 1))
fi

if [[ "$FAILURES" -gt 0 ]]; then
  echo "$FAILURES assertion(s) failed."
  exit 1
fi
echo "All assert-pm2-listeners.sh end-to-end assertions passed."
