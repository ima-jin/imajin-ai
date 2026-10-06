#!/usr/bin/env bash
# pm2-health-check.test.sh — end-to-end coverage for scripts/pm2-health-check.sh
# (#2572), the entry point the scheduled post-deploy health check runs.
#
# Runs the real wrapper (and the real check-pm2-restarts.sh /
# check-pm2-status.sh it calls) with `pm2` and `curl` faked via a PATH shim,
# asserting that:
#   - healthy pm2 passes (and prints nothing with PM2_HEALTH_QUIET=1);
#   - an app parked errored/stopped fails the run and POSTs the webhook;
#   - a crash loop (restart counter jump) fails the run and POSTs the webhook;
#   - the worst of the two checks decides the exit status;
#   - the webhook URL falls back to the 0600 file the installer writes (cron
#     has no environment), and the environment wins when both are present;
#   - bad scope / missing ecosystem / missing pm2 exit 2 (install check).
#
# Usage: scripts/pm2-health-check.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HEALTH="$SCRIPT_DIR/pm2-health-check.sh"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/pm2-health-check-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
FAKE_BIN="$WORK/bin"
mkdir -p "$FAKE_BIN"

if ! command -v node >/dev/null 2>&1; then
  echo "node not found on PATH — cannot run tests" >&2
  exit 1
fi

cat > "$WORK/eco.config.js" <<'EOF'
module.exports = { apps: [ { name: 't-events' }, { name: 't-auth' } ] };
EOF
ECO="$WORK/eco.config.js"

cat > "$FAKE_BIN/pm2" <<'EOF'
#!/usr/bin/env bash
[[ "$1" = "jlist" ]] && cat "$FAKE_JLIST"
exit 0
EOF
cat > "$FAKE_BIN/curl" <<'EOF'
#!/usr/bin/env bash
url=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -d|-m|-X|-H) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
echo "$url" >> "$CURL_LOG"
exit 0
EOF
chmod +x "$FAKE_BIN"/*

PATH="$FAKE_BIN:$PATH"
export PATH
export FAKE_JLIST="$WORK/jlist.json"
export CURL_LOG="$WORK/curl.log"
export RESTART_ALERT_STATE="$WORK/restarts.json"
export STATUS_ALERT_STATE="$WORK/status.json"
export PM2_ALERT_WEBHOOK_FILE="$WORK/webhook"
unset RESTART_ALERT_WEBHOOK STATUS_ALERT_WEBHOOK || true

FAILURES=0
ENV_HOOK="https://env.example/hook"

# jl "name=status:restarts ..."
jl() {
  SPEC="$1" node -e '
    const procs = (process.env.SPEC || "").split(/\s+/).filter(Boolean).map((kv) => {
      const [name, rest] = kv.split("=");
      const [status, restarts] = rest.split(":");
      return { name, pm2_env: { status, restart_time: Number(restarts) } };
    });
    process.stdout.write(JSON.stringify(procs));
  '
}

# run_case <label> <expected-exit> <now> <jlist spec> <expected POSTs> [needle...]
# Extra env (e.g. PM2_HEALTH_QUIET) is passed through the caller's environment.
run_case() {
  local label="$1" expected="$2" now="$3" spec="$4" posts="$5" out status=0
  shift 5
  jl "$spec" > "$FAKE_JLIST"
  : > "$CURL_LOG"
  out="$(RESTART_ALERT_NOW="$now" STATUS_ALERT_NOW="$now" bash "$HEALTH" prod "$ECO" 2>&1)" || status=$?
  echo "$out"
  if [[ "$status" -ne "$expected" ]]; then
    echo "❌ $label: expected exit $expected, got $status"
    FAILURES=$((FAILURES + 1))
    return
  fi
  if [[ "$(wc -l < "$CURL_LOG" | tr -d ' ')" -ne "$posts" ]]; then
    echo "❌ $label: expected $posts webhook POST(s), got: $(cat "$CURL_LOG")"
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

reset_state() { rm -f "$RESTART_ALERT_STATE" "$STATUS_ALERT_STATE"; }
T0=1000000

export RESTART_ALERT_WEBHOOK="$ENV_HOOK"

reset_state
run_case "healthy pm2 passes and reports both checks" 0 "$T0" "t-events=online:0 t-auth=online:0" 0 \
  "no app exceeded" "no declared app is errored or stopped"

reset_state
out="$(PM2_HEALTH_QUIET=1 RESTART_ALERT_NOW="$T0" STATUS_ALERT_NOW="$T0" bash "$HEALTH" prod "$ECO" 2>&1)"
if [[ -z "$out" ]]; then
  echo "✅ PM2_HEALTH_QUIET=1 prints nothing when healthy"
else
  echo "❌ quiet mode printed: $out"
  FAILURES=$((FAILURES + 1))
fi

reset_state
run_case "parked errored app fails and POSTs" 1 "$T0" "t-events=errored:0 t-auth=online:0" 1 \
  "t-events is errored in pm2"

reset_state
PM2_HEALTH_QUIET=1 run_case "problems are printed even in quiet mode" 1 "$T0" "t-events=online:0 t-auth=stopped:0" 1 \
  "t-auth is stopped in pm2"

# Crash loop: restart counter jumps by 100 inside the window while pm2 still
# says `online`/`waiting restart` — only the restart check can see it.
reset_state
run_case "baseline sample" 0 "$T0" "t-events=online:10 t-auth=online:0" 0
run_case "crash loop fails and POSTs" 1 $((T0 + 60)) "t-events=online:110 t-auth=online:0" 1 \
  "t-events restarted 100 times"

reset_state
run_case "baseline for combined problem" 0 "$T0" "t-events=online:10 t-auth=online:0" 0
run_case "crash loop and a parked app are both reported (worst exit wins)" 1 $((T0 + 60)) \
  "t-events=online:110 t-auth=errored:0" 2 "t-events restarted 100 times" "t-auth is errored in pm2"

# Webhook source: the file is used when the environment has none; the
# environment wins when both exist.
unset RESTART_ALERT_WEBHOOK
echo "https://file.example/hook" > "$PM2_ALERT_WEBHOOK_FILE"
reset_state
jl "t-events=errored:0" > "$FAKE_JLIST"
: > "$CURL_LOG"
status=0
RESTART_ALERT_NOW="$T0" STATUS_ALERT_NOW="$T0" bash "$HEALTH" prod "$ECO" >/dev/null 2>&1 || status=$?
if [[ "$status" -eq 1 && "$(cat "$CURL_LOG")" = "https://file.example/hook" ]]; then
  echo "✅ webhook URL is read from the webhook file when the environment has none"
else
  echo "❌ webhook file: exit $status, POSTs: $(cat "$CURL_LOG")"
  FAILURES=$((FAILURES + 1))
fi

reset_state
: > "$CURL_LOG"
status=0
RESTART_ALERT_WEBHOOK="$ENV_HOOK" RESTART_ALERT_NOW="$T0" STATUS_ALERT_NOW="$T0" bash "$HEALTH" prod "$ECO" >/dev/null 2>&1 || status=$?
if [[ "$status" -eq 1 && "$(cat "$CURL_LOG")" = "$ENV_HOOK" ]]; then
  echo "✅ the environment's webhook wins over the file"
else
  echo "❌ env webhook: exit $status, POSTs: $(cat "$CURL_LOG")"
  FAILURES=$((FAILURES + 1))
fi

# Install check / usage: exit 2.
expect_exit_2() {
  local label="$1" needle="$2"
  shift 2
  local out status=0
  out="$("$@" 2>&1)" || status=$?
  if [[ "$status" -eq 2 ]] && grep -qF -- "$needle" <<< "$out"; then
    echo "✅ $label"
  else
    echo "❌ $label: expected exit 2 mentioning '$needle', got $status: $out"
    FAILURES=$((FAILURES + 1))
  fi
}

expect_exit_2 "unknown scope exits 2" "unknown scope" bash "$HEALTH" bogus "$ECO"
expect_exit_2 "missing ecosystem file exits 2" "ecosystem file not found" bash "$HEALTH" prod "$WORK/nope.config.js"

NOPM2_BIN="$WORK/nopm2-bin"
mkdir -p "$NOPM2_BIN"
for tool in node dirname hostname; do
  ln -sf "$(command -v "$tool")" "$NOPM2_BIN/$tool"
done
BASH_BIN="$(command -v bash)"
expect_exit_2 "pm2 not installed exits 2" "'pm2' is not installed" env PATH="$NOPM2_BIN" "$BASH_BIN" "$HEALTH" prod "$ECO"

if [[ "$FAILURES" -gt 0 ]]; then
  echo "$FAILURES assertion(s) failed."
  exit 1
fi
echo "All pm2-health-check.sh end-to-end assertions passed."
