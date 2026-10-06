#!/usr/bin/env bash
# install-pm2-health-cron.test.sh — end-to-end coverage for
# scripts/install-pm2-health-cron.sh (#2572).
#
# Runs the real installer with `crontab`, `pm2` and `curl` faked via a PATH
# shim (the fake crontab keeps its table in $CRONTAB_FILE), asserting that:
#   - a first run installs one every-minute entry for the scope;
#   - re-running replaces it instead of duplicating it (idempotent), leaves
#     unrelated crontab lines alone, and keeps dev and prod entries separate;
#   - the PM2_ALERT_WEBHOOK secret lands in a 0600 file, never in the crontab,
#     and an unset secret keeps the existing file (with a warning when none);
#   - the entry survives cron's environment: executed the way cron would (empty
#     env, `sh -c`, `\%` unescaped) it runs the health check, stays silent when
#     healthy, logs the problem and POSTs the stored webhook when an app is
#     errored;
#   - the install check fails (exit 2) and leaves the crontab untouched when
#     pm2, the ecosystem file or crontab is missing, or the scope is bad.
#
# Usage: scripts/install-pm2-health-cron.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL="$SCRIPT_DIR/install-pm2-health-cron.sh"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/install-pm2-health-cron-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
FAKE_BIN="$WORK/bin"
HOME_DIR="$WORK/home"
mkdir -p "$FAKE_BIN" "$HOME_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "node not found on PATH — cannot run tests" >&2
  exit 1
fi

cat > "$WORK/eco.config.js" <<'EOF'
module.exports = { apps: [ { name: 't-events' } ] };
EOF
ECO="$WORK/eco.config.js"

cat > "$FAKE_BIN/crontab" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  -l) [[ -f "$CRONTAB_FILE" ]] || { echo "no crontab for test" >&2; exit 1; }
      cat "$CRONTAB_FILE" ;;
  -)  cat > "$CRONTAB_FILE" ;;
esac
EOF
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

export CRONTAB_FILE="$WORK/crontab"
export FAKE_JLIST="$WORK/jlist.json"
export CURL_LOG="$WORK/curl.log"
export HOME="$HOME_DIR"
NODE_DIR="$(dirname "$(command -v node)")"
# The installer bakes its PATH into the entry, so the cron-style run below can
# find pm2, curl and node with an otherwise empty environment.
PATH="$FAKE_BIN:$NODE_DIR:/usr/bin:/bin"
export PATH
unset PM2_ALERT_WEBHOOK PM2_ALERT_WEBHOOK_FILE || true

FAILURES=0
pass() { echo "✅ $1"; }
fail() { echo "❌ $1"; FAILURES=$((FAILURES + 1)); }

count_lines() { grep -cF -- "$1" "$CRONTAB_FILE" || true; }

# 1. First install: one every-minute entry for dev.
rm -f "$CRONTAB_FILE"
out="$(bash "$INSTALL" dev "$ECO" 2>&1)" && status=0 || status=$?
echo "$out"
if [[ "$status" -eq 0 && "$(count_lines '# imajin-pm2-health:dev')" -eq 1 ]] \
  && grep -qE '^\* \* \* \* \* ' "$CRONTAB_FILE" \
  && grep -qF "pm2-health-check.sh" "$CRONTAB_FILE" \
  && grep -qF "PM2_HEALTH_QUIET=1" "$CRONTAB_FILE" \
  && grep -qF "$ECO" "$CRONTAB_FILE"; then
  pass "first run installs one every-minute dev entry"
else
  fail "first run: exit $status, crontab: $(cat "$CRONTAB_FILE" 2>/dev/null)"
fi
if grep -qF "No alert webhook configured" <<< "$out"; then
  pass "no webhook secret and no stored file warns that alerts are log-only"
else
  fail "expected a no-webhook warning, got: $out"
fi

# 2. Idempotent, and unrelated lines survive.
printf '%s\n' '0 3 * * * /usr/local/bin/backup.sh' > "$CRONTAB_FILE.seed"
{ cat "$CRONTAB_FILE.seed"; cat "$CRONTAB_FILE"; } > "$CRONTAB_FILE.new" && mv "$CRONTAB_FILE.new" "$CRONTAB_FILE"
bash "$INSTALL" dev "$ECO" >/dev/null 2>&1 || true
bash "$INSTALL" dev "$ECO" >/dev/null 2>&1 || true
if [[ "$(count_lines '# imajin-pm2-health:dev')" -eq 1 && "$(count_lines '/usr/local/bin/backup.sh')" -eq 1 ]]; then
  pass "re-running keeps exactly one dev entry and leaves other crontab lines alone"
else
  fail "idempotency: $(cat "$CRONTAB_FILE")"
fi

# 3. dev and prod entries are independent.
bash "$INSTALL" prod "$ECO" >/dev/null 2>&1 || true
bash "$INSTALL" dev "$ECO" >/dev/null 2>&1 || true
if [[ "$(count_lines '# imajin-pm2-health:dev')" -eq 1 && "$(count_lines '# imajin-pm2-health:prod')" -eq 1 ]]; then
  pass "dev and prod entries coexist and are replaced independently"
else
  fail "dev/prod: $(cat "$CRONTAB_FILE")"
fi

# 4. The webhook secret goes to a 0600 file, never into the crontab.
SECRET="https://hooks.example/services/T000/B000/s3cr3t"
PM2_ALERT_WEBHOOK="$SECRET" bash "$INSTALL" prod "$ECO" >/dev/null 2>&1 || true
WEBHOOK_FILE="$HOME_DIR/.config/imajin/pm2-alert-webhook.prod"
perms="$(stat -c '%a' "$WEBHOOK_FILE" 2>/dev/null || stat -f '%Lp' "$WEBHOOK_FILE")"
if [[ "$(cat "$WEBHOOK_FILE")" = "$SECRET" && "$perms" = "600" ]] && ! grep -qF "s3cr3t" "$CRONTAB_FILE"; then
  pass "webhook secret stored in a 0600 file and not in the crontab"
else
  fail "webhook storage: perms=$perms file=$(cat "$WEBHOOK_FILE" 2>/dev/null)"
fi

out="$(bash "$INSTALL" prod "$ECO" 2>&1)" || true
if [[ "$(cat "$WEBHOOK_FILE")" = "$SECRET" ]] && ! grep -qF "No alert webhook configured" <<< "$out"; then
  pass "an unset secret keeps the stored webhook and does not warn"
else
  fail "kept webhook: $(cat "$WEBHOOK_FILE") / $out"
fi

# 5. Run the entry the way cron does: empty environment, `sh -c`, \% unescaped.
cron_command() {
  local scope="$1"
  grep -F "# imajin-pm2-health:$scope" "$CRONTAB_FILE" \
    | sed -e 's/^\* \* \* \* \* //' -e "s/ # imajin-pm2-health:$scope\$//" -e 's/\\%/%/g'
}
LOG="$HOME_DIR/.cache/imajin/pm2-health.prod.log"
rm -f "$LOG"
echo '[{"name":"t-events","pm2_env":{"status":"online","restart_time":0}}]' > "$FAKE_JLIST"
: > "$CURL_LOG"
status=0
env -i HOME="$HOME_DIR" CRONTAB_FILE="$CRONTAB_FILE" FAKE_JLIST="$FAKE_JLIST" CURL_LOG="$CURL_LOG" \
  RESTART_ALERT_STATE="$WORK/r.json" STATUS_ALERT_STATE="$WORK/s.json" \
  sh -c "$(cron_command prod)" || status=$?
if [[ "$status" -eq 0 && ! -s "$LOG" && ! -s "$CURL_LOG" ]]; then
  pass "cron-style run with a healthy pm2 exits 0 and stays silent"
else
  fail "cron healthy: exit $status, log: $(cat "$LOG" 2>/dev/null), POSTs: $(cat "$CURL_LOG")"
fi

echo '[{"name":"t-events","pm2_env":{"status":"errored","restart_time":0}}]' > "$FAKE_JLIST"
status=0
env -i HOME="$HOME_DIR" CRONTAB_FILE="$CRONTAB_FILE" FAKE_JLIST="$FAKE_JLIST" CURL_LOG="$CURL_LOG" \
  RESTART_ALERT_STATE="$WORK/r.json" STATUS_ALERT_STATE="$WORK/s.json" \
  sh -c "$(cron_command prod)" || status=$?
if grep -qF "t-events is errored in pm2" "$LOG" && [[ "$(cat "$CURL_LOG")" = "$SECRET" ]]; then
  pass "cron-style run logs an errored app and POSTs the stored webhook"
else
  fail "cron errored: exit $status, log: $(cat "$LOG" 2>/dev/null), POSTs: $(cat "$CURL_LOG")"
fi

# 6. % in PATH is escaped for crontab and restored for sh.
rm -f "$CRONTAB_FILE"
PATH_WITH_PCT="$FAKE_BIN:$NODE_DIR:/usr/bin:/bin:/opt/odd%dir"
PATH="$PATH_WITH_PCT" bash "$INSTALL" dev "$ECO" >/dev/null 2>&1 || true
if grep -qF '/opt/odd\%dir' "$CRONTAB_FILE" && ! grep -qE '[^\\]%' "$CRONTAB_FILE"; then
  pass "a % in PATH is backslash-escaped in the crontab line"
else
  fail "percent escaping: $(cat "$CRONTAB_FILE")"
fi

# 7. Install check: failures exit 2 and never touch the crontab.
echo "# sentinel" > "$CRONTAB_FILE"
expect_exit_2() {
  local label="$1" needle="$2"
  shift 2
  local out status=0
  out="$("$@" 2>&1)" || status=$?
  if [[ "$status" -eq 2 ]] && grep -qF -- "$needle" <<< "$out" && [[ "$(cat "$CRONTAB_FILE")" = "# sentinel" ]]; then
    pass "$label"
  else
    fail "$label: expected exit 2 mentioning '$needle' and an untouched crontab, got $status: $out"
  fi
}

expect_exit_2 "no scope exits 2" "usage:" bash "$INSTALL"
expect_exit_2 "bad scope exits 2" "usage:" bash "$INSTALL" staging "$ECO"
expect_exit_2 "missing ecosystem file exits 2" "ecosystem file not found" bash "$INSTALL" dev "$WORK/nope.config.js"

NOPM2_BIN="$WORK/nopm2-bin"
mkdir -p "$NOPM2_BIN"
for tool in node dirname hostname crontab; do
  ln -sf "$(command -v "$tool")" "$NOPM2_BIN/$tool"
done
BASH_BIN="$(command -v bash)"
expect_exit_2 "pm2 not installed exits 2" "'pm2' is not installed" env PATH="$NOPM2_BIN" "$BASH_BIN" "$INSTALL" dev "$ECO"

NOCRON_BIN="$WORK/nocron-bin"
mkdir -p "$NOCRON_BIN"
for tool in node dirname hostname pm2; do
  ln -sf "$(command -v "$tool")" "$NOCRON_BIN/$tool"
done
expect_exit_2 "crontab not installed exits 2" "'crontab' is not installed" env PATH="$NOCRON_BIN" "$BASH_BIN" "$INSTALL" dev "$ECO"

if [[ "$FAILURES" -gt 0 ]]; then
  echo "$FAILURES assertion(s) failed."
  exit 1
fi
echo "All install-pm2-health-cron.sh end-to-end assertions passed."
