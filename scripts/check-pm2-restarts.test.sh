#!/usr/bin/env bash
# check-pm2-restarts.test.sh — end-to-end coverage for
# scripts/check-pm2-restarts.sh (#2547).
#
# Runs the real script with `pm2` faked via a PATH shim (restart counts come
# from $FAKE_RESTARTS_FILE) and the clock injected via RESTART_ALERT_NOW,
# asserting that:
#   - the first run (no history) never alerts;
#   - a slow trickle of restarts under the threshold passes;
#   - the #2547 incident (~1 restart/s crash loop) fails and names the app;
#   - restarts older than the window age out;
#   - a counter that goes backwards (pm2 reset) does not alert;
#   - apps outside the ecosystem file are ignored;
#   - a bad scope / missing ecosystem exits 2.
#
# Usage: scripts/check-pm2-restarts.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK_SCRIPT="$SCRIPT_DIR/check-pm2-restarts.sh"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/check-pm2-restarts-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
FAKE_BIN="$WORK/bin"
mkdir -p "$FAKE_BIN"

if ! command -v node >/dev/null 2>&1; then
  echo "node not found on PATH — cannot run tests" >&2
  exit 1
fi

cat > "$WORK/eco.config.js" <<'EOF'
module.exports = { apps: [
  { name: 't-events' },
  { name: 't-auth' },
  // One-shot / cron-style job (autorestart:false): pm2 leaves it `stopped` after
  // a clean exit and never bumps restart_time, so it must not look like a crash loop.
  { name: 't-oneshot', autorestart: false },
] };
EOF

# FAKE_RESTARTS_FILE holds "<name>=<count>" lines.
cat > "$FAKE_BIN/pm2" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" = "jlist" ]]; then
  node -e '
    const lines = require("fs").readFileSync(process.env.FAKE_RESTARTS_FILE, "utf8").trim().split("\n");
    const out = lines.filter(Boolean).map((l) => {
      const [name, n] = l.split("=");
      return { name, pm2_env: { restart_time: Number(n) } };
    });
    console.log(JSON.stringify(out));
  '
fi
EOF
chmod +x "$FAKE_BIN"/*

PATH="$FAKE_BIN:$PATH"
export PATH
export FAKE_RESTARTS_FILE="$WORK/restarts.txt"
export RESTART_ALERT_STATE="$WORK/state.json"
export RESTART_ALERT_THRESHOLD=5 RESTART_ALERT_WINDOW=600

FAILURES=0

# run_case <label> <expected-exit> <now> <restarts: "name=n name=n"> [needle...]
run_case() {
  local label="$1" expected="$2" now="$3" restarts="$4" out status=0
  shift 4
  tr ' ' '\n' <<< "$restarts" > "$FAKE_RESTARTS_FILE"
  out="$(RESTART_ALERT_NOW="$now" bash "$CHECK_SCRIPT" prod "$WORK/eco.config.js" 2>&1)" || status=$?
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

T0=1000000
run_case "first run (no history) passes" 0 "$T0" "t-events=48000 t-auth=2"
run_case "small trickle under threshold passes" 0 $((T0 + 60)) "t-events=48003 t-auth=3"
run_case "crash loop (~1 restart/s) fails and names the app (#2547)" 1 $((T0 + 120)) \
  "t-events=48100 t-auth=3" "t-events restarted 100 times" "threshold 5 per 600s"
run_case "alert persists while the burst is inside the window; unrelated app not blamed" 1 $((T0 + 180)) \
  "t-events=48100 t-auth=3" "t-events restarted 100 times"
run_case "stable count passes once the burst ages out" 0 $((T0 + 800)) "t-events=48100 t-auth=3" "no app exceeded"

# Window expiry: a clean state, a burst, then silence until the burst ages out.
rm -f "$RESTART_ALERT_STATE"
run_case "baseline" 0 "$T0" "t-events=10 t-auth=0"
run_case "burst inside the window fails" 1 $((T0 + 30)) "t-events=30 t-auth=0" "t-events restarted 20 times"
run_case "burst aged out of the window passes" 0 $((T0 + 700)) "t-events=30 t-auth=0"

# pm2 counter reset (pm2 delete / reset) must not look like negative or huge delta.
rm -f "$RESTART_ALERT_STATE"
run_case "baseline before reset" 0 "$T0" "t-events=500 t-auth=0"
run_case "counter reset does not alert" 0 $((T0 + 60)) "t-events=1 t-auth=0"

# Apps pm2 knows about but the ecosystem file does not declare are ignored.
rm -f "$RESTART_ALERT_STATE"
run_case "baseline with foreign app" 0 "$T0" "t-events=0 t-foreign=0"
run_case "foreign app crash loop is ignored" 0 $((T0 + 60)) "t-events=0 t-foreign=9999"

# A one-shot job that exits normally (stopped, autorestart:false) keeps a flat
# restart counter however many times it has run, so it never trips the alert
# (#2550 cron-style entries), while a real crash loop beside it still does.
rm -f "$RESTART_ALERT_STATE"
run_case "baseline with one-shot job" 0 "$T0" "t-events=0 t-oneshot=0"
run_case "one-shot job exiting normally does not alert" 0 $((T0 + 60)) "t-events=0 t-oneshot=0" "no app exceeded"
run_case "crash loop is still named next to a healthy one-shot job" 1 $((T0 + 120)) \
  "t-events=50 t-oneshot=0" "t-events restarted 50 times"

status=0
bash "$CHECK_SCRIPT" bogus >/dev/null 2>&1 || status=$?
if [[ "$status" -eq 2 ]]; then
  echo "✅ unknown scope exits 2"
else
  echo "❌ unknown scope: expected exit 2, got $status"
  FAILURES=$((FAILURES + 1))
fi

status=0
bash "$CHECK_SCRIPT" prod "$WORK/nope.config.js" >/dev/null 2>&1 || status=$?
if [[ "$status" -eq 2 ]]; then
  echo "✅ missing ecosystem file exits 2"
else
  echo "❌ missing ecosystem file: expected exit 2, got $status"
  FAILURES=$((FAILURES + 1))
fi

if [[ "$FAILURES" -gt 0 ]]; then
  echo "$FAILURES assertion(s) failed."
  exit 1
fi
echo "All check-pm2-restarts.sh end-to-end assertions passed."
