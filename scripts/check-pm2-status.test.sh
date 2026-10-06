#!/usr/bin/env bash
# check-pm2-status.test.sh — end-to-end coverage for scripts/check-pm2-status.sh
# (#2572).
#
# Runs the real script with `pm2` and `curl` faked via a PATH shim (the process
# list comes from $FAKE_JLIST, every webhook POST is logged to $CURL_LOG) and
# the clock injected via STATUS_ALERT_NOW, asserting that:
#   - an app parked `errored` or `stopped` fails the run, is named, and is
#     POSTed to the webhook as {"text": ...};
#   - healthy apps, transient states (launching / waiting restart), apps the
#     ecosystem doesn't declare, and declared-but-unknown apps do not alert;
#   - a `stopped` one-shot (autorestart: false) does not alert, an `errored`
#     one-shot still does;
#   - the same parked app is not re-POSTed every run (repeat interval), is
#     re-POSTed once the interval passes, and alerts again after a recovery;
#   - no webhook / a failing webhook never changes the exit status;
#   - RESTART_ALERT_WEBHOOK is the fallback webhook;
#   - a jlist far larger than MAX_ARG_STRLEN (128 KiB) is handled (file, not
#     env/argv, #2603) and no temp file is left behind;
#   - bad scope / missing ecosystem / missing pm2 / failing or unparseable
#     `pm2 jlist` exit 2 without alerting.
#
# Usage: scripts/check-pm2-status.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK_SCRIPT="$SCRIPT_DIR/check-pm2-status.sh"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/check-pm2-status-test.XXXXXX")"
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
  { name: 't-nothosted' },
  // One-shot job: pm2 leaves it `stopped` after a clean exit.
  { name: 't-oneshot', autorestart: false },
] };
EOF
ECO="$WORK/eco.config.js"

cat > "$FAKE_BIN/pm2" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" = "jlist" ]]; then
  [[ "${FAKE_PM2_FAIL_JLIST:-}" = "true" ]] && exit 1
  cat "$FAKE_JLIST"
fi
exit 0
EOF
cat > "$FAKE_BIN/curl" <<'EOF'
#!/usr/bin/env bash
# Log "<url> <payload>" for the -d payload and the final URL argument.
payload="" url=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -d) payload="$2"; shift 2 ;;
    -m|-X|-H) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
echo "$url $payload" >> "$CURL_LOG"
[[ "${FAKE_CURL_FAIL:-}" = "true" ]] && exit 22
exit 0
EOF
chmod +x "$FAKE_BIN"/*

PATH="$FAKE_BIN:$PATH"
export PATH
export FAKE_JLIST="$WORK/jlist.json"
export CURL_LOG="$WORK/curl.log"
export STATUS_ALERT_STATE="$WORK/state.json"
export STATUS_ALERT_REPEAT=3600
export STATUS_ALERT_WEBHOOK="https://hook.example/alert"
unset RESTART_ALERT_WEBHOOK || true

SCRIPT_TMP="$WORK/script-tmp"
mkdir -p "$SCRIPT_TMP"

FAILURES=0

# jl "name=status ..." -> a pm2 jlist for those processes.
jl() {
  local spec="$1"
  SPEC="$spec" node -e '
    const procs = (process.env.SPEC || "").split(/\s+/).filter(Boolean).map((kv) => {
      const [name, status] = kv.split("=");
      return { name, pm2_env: { status } };
    });
    process.stdout.write(JSON.stringify(procs));
  '
}

# run_case <label> <expected-exit> <now> <jlist spec> <expected curl posts> [needle...]
run_case() {
  local label="$1" expected="$2" now="$3" spec="$4" posts="$5" out status=0
  shift 5
  jl "$spec" > "$FAKE_JLIST"
  : > "$CURL_LOG"
  out="$(STATUS_ALERT_NOW="$now" TMPDIR="$SCRIPT_TMP" bash "$CHECK_SCRIPT" prod "$ECO" 2>&1)" || status=$?
  echo "$out"
  if [[ "$status" -ne "$expected" ]]; then
    echo "❌ $label: expected exit $expected, got $status"
    FAILURES=$((FAILURES + 1))
    return
  fi
  if [[ "$(wc -l < "$CURL_LOG" | tr -d ' ')" -ne "$posts" ]]; then
    echo "❌ $label: expected $posts webhook POST(s), got:"
    cat "$CURL_LOG"
    FAILURES=$((FAILURES + 1))
    return
  fi
  if [[ -n "$(ls -A "$SCRIPT_TMP")" ]]; then
    echo "❌ $label: temp files left behind: $(ls -A "$SCRIPT_TMP")"
    FAILURES=$((FAILURES + 1))
    return
  fi
  local needle
  for needle in "$@"; do
    if ! grep -qF -- "$needle" <<< "$out$(cat "$CURL_LOG")"; then
      echo "❌ $label: output is missing '$needle'"
      FAILURES=$((FAILURES + 1))
      return
    fi
  done
  echo "✅ $label"
}

T0=1000000
reset_state() { rm -f "$STATUS_ALERT_STATE"; }

reset_state
run_case "all declared apps online passes" 0 "$T0" "t-events=online t-auth=online" 0 "no declared app is errored or stopped"

reset_state
run_case "errored app fails, is named and POSTed to the webhook" 1 "$T0" "t-events=errored t-auth=online" 1 \
  "t-events is errored in pm2" "https://hook.example/alert" '"text":"pm2 apps down on' "t-events is errored;"

reset_state
run_case "stopped app fails and is POSTed" 1 "$T0" "t-events=online t-auth=stopped" 1 "t-auth is stopped in pm2" "t-auth is stopped;"

reset_state
run_case "stopped one-shot (autorestart:false) does not alert" 0 "$T0" "t-events=online t-oneshot=stopped" 0 "no declared app"

reset_state
run_case "errored one-shot still alerts" 1 "$T0" "t-events=online t-oneshot=errored" 1 "t-oneshot is errored in pm2"

reset_state
run_case "transient states (launching, waiting restart, stopping) do not alert" 0 "$T0" \
  "t-events=launching t-auth=waiting_restart t-oneshot=stopping" 0 "no declared app"

reset_state
run_case "errored app the ecosystem does not declare is ignored" 0 "$T0" "t-events=online t-foreign=errored" 0 "no declared app"

reset_state
run_case "declared app unknown to pm2 (not hosted here) is ignored" 0 "$T0" "t-events=online" 0 "no declared app"

reset_state
run_case "two parked apps are both named in one POST" 1 "$T0" "t-events=errored t-auth=stopped" 1 \
  "t-events is errored in pm2" "t-auth is stopped in pm2" "t-events is errored; t-auth is stopped;"

# Repeat interval: a parked app keeps failing every run but is POSTed only once
# per STATUS_ALERT_REPEAT; it is POSTed again after the interval, and again
# after it recovered and relapsed.
reset_state
run_case "first run of a parked app POSTs" 1 "$T0" "t-events=errored" 1 "t-events is errored"
run_case "still parked a minute later: fails but is not re-POSTed" 1 $((T0 + 60)) "t-events=errored" 0 "t-events is errored in pm2"
run_case "still parked after the repeat interval: POSTs again" 1 $((T0 + 3700)) "t-events=errored" 1 "t-events is errored;"
run_case "recovered passes" 0 $((T0 + 3760)) "t-events=online" 0 "no declared app"
run_case "relapse after recovery POSTs immediately" 1 $((T0 + 3820)) "t-events=errored" 1 "t-events is errored;"

# A new problem is POSTed even while another one is inside its repeat window,
# and only the new one is in the message.
reset_state
run_case "baseline for a second problem" 1 "$T0" "t-events=errored" 1 "t-events is errored"
run_case "new problem POSTs alone while the old one is quiet" 1 $((T0 + 60)) "t-events=errored t-auth=stopped" 1 \
  "t-auth is stopped;"
if grep -qF "t-events is errored;" "$CURL_LOG"; then
  echo "❌ quiet problem was repeated in the new POST"
  FAILURES=$((FAILURES + 1))
else
  echo "✅ quiet problem is not repeated in the new POST"
fi

# Webhook behaviour.
reset_state
jl "t-events=errored" > "$FAKE_JLIST"
: > "$CURL_LOG"
status=0
out="$(env -u STATUS_ALERT_WEBHOOK STATUS_ALERT_NOW="$T0" bash "$CHECK_SCRIPT" prod "$ECO" 2>&1)" || status=$?
if [[ "$status" -eq 1 && ! -s "$CURL_LOG" ]]; then
  echo "✅ no webhook configured: still fails, nothing POSTed"
else
  echo "❌ no webhook: expected exit 1 and no POST, got $status / $(cat "$CURL_LOG")"
  FAILURES=$((FAILURES + 1))
fi

reset_state
: > "$CURL_LOG"
status=0
out="$(env -u STATUS_ALERT_WEBHOOK RESTART_ALERT_WEBHOOK="https://fallback.example/hook" STATUS_ALERT_NOW="$T0" bash "$CHECK_SCRIPT" prod "$ECO" 2>&1)" || status=$?
if [[ "$status" -eq 1 ]] && grep -qF "https://fallback.example/hook" "$CURL_LOG"; then
  echo "✅ RESTART_ALERT_WEBHOOK is used as the fallback webhook"
else
  echo "❌ fallback webhook: exit $status, curl log: $(cat "$CURL_LOG")"
  FAILURES=$((FAILURES + 1))
fi

reset_state
status=0
out="$(FAKE_CURL_FAIL=true STATUS_ALERT_NOW="$T0" bash "$CHECK_SCRIPT" prod "$ECO" 2>&1)" || status=$?
if [[ "$status" -eq 1 ]] && grep -qF "webhook delivery failed" <<< "$out"; then
  echo "✅ failing webhook only warns; exit status stays 1"
else
  echo "❌ failing webhook: exit $status, output: $out"
  FAILURES=$((FAILURES + 1))
fi

# A jlist well over 256 KiB (2x MAX_ARG_STRLEN) must be handled (#2603).
reset_state
node -e '
  const noise = "x".repeat(2048);
  const procs = [{ name: "t-events", pm2_env: { status: "errored" } }];
  for (let i = 0; i < 200; i++) procs.push({ name: "filler-" + i, pm2_env: { status: "online", env: { NOISE: noise } } });
  process.stdout.write(JSON.stringify(procs));
' > "$FAKE_JLIST"
if [[ "$(wc -c < "$FAKE_JLIST")" -le 262144 ]]; then
  echo "❌ test setup: synthetic jlist is too small"
  FAILURES=$((FAILURES + 1))
fi
: > "$CURL_LOG"
status=0
out="$(STATUS_ALERT_NOW="$T0" TMPDIR="$SCRIPT_TMP" bash "$CHECK_SCRIPT" prod "$ECO" 2>&1)" || status=$?
if [[ "$status" -eq 1 ]] && grep -qF "t-events is errored" <<< "$out" && [[ -z "$(ls -A "$SCRIPT_TMP")" ]]; then
  echo "✅ jlist > 256 KiB is handled and leaves no temp file (#2603)"
else
  echo "❌ large jlist: exit $status, output: $out"
  FAILURES=$((FAILURES + 1))
fi

# Environment / usage errors exit 2 and never alert.
expect_exit_2() {
  local label="$1" needle="$2"
  shift 2
  local out status=0
  : > "$CURL_LOG"
  out="$("$@" 2>&1)" || status=$?
  if [[ "$status" -eq 2 ]] && grep -qF -- "$needle" <<< "$out" && [[ ! -s "$CURL_LOG" ]]; then
    echo "✅ $label"
  else
    echo "❌ $label: expected exit 2 mentioning '$needle', got $status: $out"
    FAILURES=$((FAILURES + 1))
  fi
}

jl "t-events=errored" > "$FAKE_JLIST"
expect_exit_2 "unknown scope exits 2" "unknown scope" bash "$CHECK_SCRIPT" bogus "$ECO"
expect_exit_2 "missing ecosystem file exits 2" "ecosystem file not found" bash "$CHECK_SCRIPT" prod "$WORK/nope.config.js"
expect_exit_2 "non-numeric repeat exits 2" "STATUS_ALERT_REPEAT" env STATUS_ALERT_REPEAT=soon bash "$CHECK_SCRIPT" prod "$ECO"
expect_exit_2 "failing pm2 jlist exits 2" "'pm2 jlist' failed" env FAKE_PM2_FAIL_JLIST=true bash "$CHECK_SCRIPT" prod "$ECO"

echo "this is not json" > "$FAKE_JLIST"
expect_exit_2 "unparseable pm2 jlist exits 2" "could not load ecosystem file or pm2 output" bash "$CHECK_SCRIPT" prod "$ECO"

# pm2 not installed: PATH holds only what the script needs to reach its
# preflight, so pm2 is genuinely not found (install check, #2572).
NOPM2_BIN="$WORK/nopm2-bin"
mkdir -p "$NOPM2_BIN"
for tool in node dirname hostname; do
  ln -sf "$(command -v "$tool")" "$NOPM2_BIN/$tool"
done
BASH_BIN="$(command -v bash)"
expect_exit_2 "pm2 not installed exits 2" "'pm2' is not installed" env PATH="$NOPM2_BIN" "$BASH_BIN" "$CHECK_SCRIPT" prod "$ECO"

if [[ "$FAILURES" -gt 0 ]]; then
  echo "$FAILURES assertion(s) failed."
  exit 1
fi
echo "All check-pm2-status.sh end-to-end assertions passed."
