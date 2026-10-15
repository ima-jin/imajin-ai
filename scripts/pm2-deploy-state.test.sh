#!/usr/bin/env bash
# Execute the actual workflow blocks, real reconcile and real health scripts
# with PATH-shimmed pm2/ss only. No daemon, server or deployment is touched.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pm2-deploy-state-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/repo" "$WORK/bin" "$WORK/tmp"
cp -r "$SCRIPT_DIR" "$WORK/repo/scripts"
export FAKE_JLIST="$WORK/jlist.json" PM2_LOG="$WORK/pm2.log"
export GITHUB_ENV="$WORK/github-env" TMPDIR="$WORK/tmp"
export STATUS_ALERT_STATE="$WORK/status.json" RESTART_ALERT_STATE="$WORK/restarts.json"
export PM2_ALERT_WEBHOOK_FILE="$WORK/no-webhook" ASSERT_TIMEOUT=0
unset PM2_DEPLOY_STOPPED_FILE RESTART_ALERT_WEBHOOK STATUS_ALERT_WEBHOOK

cat > "$WORK/bin/pm2" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" = jlist ]]; then
  cat "$FAKE_JLIST"
  exit "${FAIL_JLIST:-0}"
fi
echo "$*" >> "$PM2_LOG"
[[ "${FAIL_RESTART:-}" = "$1" ]] && exit 1
case "$1" in
  start|startOrRestart)
    names="$4"
    ;;
  restart)
    names="${*:2}"
    ;;
  *) exit 0 ;;
esac
node - "$names" <<'JS'
const fs = require('node:fs');
const procs = JSON.parse(fs.readFileSync(process.env.FAKE_JLIST, 'utf8'));
for (const name of process.argv[2].split(/[ ,]+/).filter(Boolean)) {
  let proc = procs.find((p) => p.name === name);
  if (!proc) {
    proc = { name, pm2_env: {} };
    procs.push(proc);
  }
  if (!process.env.KEEP_STATUS || proc.pm2_env.status !== process.env.KEEP_STATUS) {
    proc.pid = 100;
    proc.pm2_env.status = 'online';
  }
}
fs.writeFileSync(process.env.FAKE_JLIST, JSON.stringify(procs));
JS
EOF
cat > "$WORK/bin/ss" <<'EOF'
#!/usr/bin/env bash
echo 'LISTEN 0 511 *:7001 *:* users:(("node",pid=100,fd=3))'
EOF
chmod +x "$WORK/bin/"*
export PATH="$WORK/bin:$PATH"

# Extract without duplicating the deployed shell logic or requiring YAML deps.
python3 - "$SCRIPT_DIR/../.github/workflows" "$WORK" <<'PY'
import pathlib, sys
for scope in ('dev', 'prod'):
    lines = (pathlib.Path(sys.argv[1]) / f'deploy-{scope}.yml').read_text().splitlines()
    for step, suffix in ((f'Restart {scope} services', ''), ('Snapshot pm2 deploy state', '-snapshot')):
        start = lines.index(f'      - name: {step}')
        start = lines.index('        run: |', start) + 1
        script = []
        for line in lines[start:]:
            if line and not line.startswith('          '):
                break
            script.append(line[10:])
        (pathlib.Path(sys.argv[2]) / f'{scope}{suffix}.sh').write_text('\n'.join(script) + '\n')
PY

assert_contains() {
  local haystack="$1" needle="$2"
  if [[ "$haystack" != *"$needle"* ]]; then
    printf 'FAIL: missing %s in:\n%s\n' "$needle" "$haystack" >&2
    exit 1
  fi
}
assert_absent() {
  local haystack="$1" needle="$2"
  if [[ "$haystack" == *"$needle"* ]]; then
    printf 'FAIL: unexpected %s in:\n%s\n' "$needle" "$haystack" >&2
    exit 1
  fi
}
run_restart() {
  : > "$PM2_LOG"
  : > "$GITHUB_ENV"
  STATUS=0
  OUT="$(cd "$WORK/repo" && bash -e "$WORK/$SCOPE-snapshot.sh" 2>&1)" || STATUS=$?
  printf '%s\n' "$OUT"
  if [[ -s "$GITHUB_ENV" ]]; then
    source "$GITHUB_ENV"
    export PM2_DEPLOY_STOPPED_FILE
  fi
  [[ "$STATUS" -eq 0 ]] || return 0
  if [[ -n "${STOP_AFTER_SNAPSHOT:-}" ]]; then
    node - "$STOP_AFTER_SNAPSHOT" <<'JS'
const fs = require('node:fs');
const file = process.env.FAKE_JLIST, procs = JSON.parse(fs.readFileSync(file));
const proc = procs.find((p) => p.name === process.argv[2]);
proc.pm2_env.status = 'stopped';
proc.pid = 0;
fs.writeFileSync(file, JSON.stringify(procs));
JS
  fi
  OUT="$(cd "$WORK/repo" && bash -e "$WORK/$SCOPE.sh" 2>&1)" || STATUS=$?
  printf '%s\n' "$OUT"
}
expect_health() {
  local expected="$1" status=0 out
  out="$(bash "$SCRIPT_DIR/pm2-health-check.sh" "$SCOPE" "$ECOSYSTEM_FILE" 2>&1)" || status=$?
  if [[ "$status" -ne "$expected" ]]; then
    printf 'FAIL: expected health %s got %s:\n%s\n' "$expected" "$status" "$out" >&2
    exit 1
  fi
  printf '%s\n' "$out"
}

set_status() {
  local name="$1" status="$2"
  node - "$name" "$status" <<'JS'
const fs = require('node:fs');
const file = process.env.FAKE_JLIST, procs = JSON.parse(fs.readFileSync(file));
const proc = procs.find((p) => p.name === process.argv[2]);
proc.pm2_env.status = process.argv[3];
proc.pid = process.argv[3] === 'online' ? 100 : 0;
fs.writeFileSync(file, JSON.stringify(procs));
JS
}

for SCOPE in dev prod; do
  export ECOSYSTEM_FILE="$WORK/$SCOPE.config.js"
  cat > "$ECOSYSTEM_FILE" <<EOF
module.exports = { apps: [
  { name: '$SCOPE-jin', cwd: '/srv', script: 'server.js' },
  { name: '$SCOPE-file-online', cwd: '/srv', script: 'server.js', env: { PORT: 7001 } },
  { name: '$SCOPE-stale', cwd: '/srv', script: 'server.js' },
  { name: '$SCOPE-file-stopped', cwd: '/srv', script: 'server.js', env: { PORT: 7002 } },
  { name: '$SCOPE-file-errored', cwd: '/srv', script: 'server.js' },
  { name: '$SCOPE-file-waiting', cwd: '/srv', script: 'server.js' },
  { name: '$SCOPE-file-launching', cwd: '/srv', script: 'server.js' },
  { name: '$SCOPE-kernel-cron', cwd: '/srv', script: 'cron.js' }
] };
EOF
  node - "$SCOPE" > "$FAKE_JLIST" <<'JS'
const scope = process.argv[2];
const specs = [
  ['jin', 'stopped'], ['file-online', 'online'], ['stale', 'online'],
  ['file-stopped', 'stopped'], ['file-errored', 'errored'],
  ['file-waiting', 'waiting restart'], ['file-launching', 'launching'],
  ['name-online', 'online'], ['name-stopped', 'stopped'], ['name-errored', 'errored'],
  ['name-waiting', 'waiting restart'], ['name-launching', 'launching'], ['no-status', undefined],
];
const procs = specs.map(([suffix, status]) => ({
  name: `${scope}-${suffix}`, pid: status === 'online' ? 100 : 0,
  pm2_env: { status, pm_exec_path: suffix === 'stale' ? '/usr/bin/npm' : '/srv/server.js',
    restart_time: 0 },
}));
procs.push({ name: 'other-app', pm2_env: { status: 'online' } });
// Large real-world jlist must never go through argv or env (#2603).
procs.push({ name: 'noise', pm2_env: { padding: 'x'.repeat(300000) } });
console.log(JSON.stringify(procs));
JS
  run_restart
  [[ "$STATUS" -eq 0 ]]
  LOG="$(cat "$PM2_LOG")"
  assert_contains "$LOG" "restart $SCOPE-name-online"
  assert_contains "$LOG" "startOrRestart $ECOSYSTEM_FILE --only $SCOPE-file-online,$SCOPE-file-errored,$SCOPE-file-waiting,$SCOPE-file-launching --update-env"
  assert_contains "$LOG" "delete $SCOPE-stale"
  assert_contains "$LOG" "start $ECOSYSTEM_FILE --only $SCOPE-stale --update-env"
  assert_contains "$LOG" "start $ECOSYSTEM_FILE --only $SCOPE-kernel-cron --update-env"
  for kind in file name; do
    assert_contains "$OUT" "Skipping $SCOPE-$kind-stopped: pm2 status=stopped"
    assert_absent "$LOG" "$SCOPE-$kind-stopped"
    for state in errored waiting launching; do
      pm2_status="$state"
      [[ "$state" != waiting ]] || pm2_status="waiting restart"
      assert_contains "$OUT" "Restarting $SCOPE-$kind-$state: pm2 status=$pm2_status (deploy recovery)"
      assert_contains "$LOG" "$SCOPE-$kind-$state"
      assert_absent "$(cat "$PM2_DEPLOY_STOPPED_FILE")" "$SCOPE-$kind-$state"
    done
  done
  assert_contains "$OUT" "Restarting $SCOPE-no-status: pm2 status=unknown"
  assert_absent "$LOG" other-app
  if [[ "$SCOPE" = prod ]]; then
    assert_contains "$LOG" "startOrRestart $ECOSYSTEM_FILE --only prod-jin --update-env"
    assert_absent "$(cat "$PM2_DEPLOY_STOPPED_FILE")" prod-jin
  else
    assert_absent "$LOG" dev-jin
  fi
  [[ "$(stat -c '%a' "$PM2_DEPLOY_STOPPED_FILE")" = 600 ]]
  assert_absent "$(cat "$PM2_DEPLOY_STOPPED_FILE")" padding
  # All crashed/launching apps recovered; stopped apps remain exempt.
  expect_health 0
  # A recovery that does not stick must still fail health, including apps
  # outside the ecosystem. A first waiting-restart sample is already red.
  for kind in file name; do
    for state in errored "waiting restart"; do
      set_status "$SCOPE-$kind-errored" "$state"
      HEALTH_OUT="$(expect_health 1)"
      assert_contains "$HEALTH_OUT" "$SCOPE-$kind-errored is $state in pm2"
      set_status "$SCOPE-$kind-errored" online
    done
  done
  LISTEN_OUT="$(bash "$SCRIPT_DIR/assert-pm2-listeners.sh" "$SCOPE" "$ECOSYSTEM_FILE")"
  assert_contains "$LISTEN_OUT" "$SCOPE-file-stopped pm2 status=stopped before deploy"
  # Restart deltas of a deliberately stopped app must not invalidate the exemption.
  printf '{"%s-file-stopped":[[1000,0]]}' "$SCOPE" > "$RESTART_ALERT_STATE"
  node - "$FAKE_JLIST" "$SCOPE-file-stopped" <<'JS'
const fs = require('node:fs');
const file = process.argv[2], procs = JSON.parse(fs.readFileSync(file));
procs.find((p) => p.name === process.argv[3]).pm2_env.restart_time = 100;
fs.writeFileSync(file, JSON.stringify(procs));
JS
  RESTART_ALERT_NOW=1060 expect_health 0
  # The snapshot cannot hide a newly errored or newly stopped online process.
  for state in stopped errored; do
    node - "$FAKE_JLIST" "$SCOPE-file-online" "$state" <<'JS'
const fs = require('node:fs');
const file = process.argv[2], procs = JSON.parse(fs.readFileSync(file));
const proc = procs.find((p) => p.name === process.argv[3]);
proc.pid = 0;
proc.pm2_env.status = process.argv[4];
fs.writeFileSync(file, JSON.stringify(procs));
JS
    expect_health 1
    status=0
    bash "$SCRIPT_DIR/assert-pm2-listeners.sh" "$SCOPE" "$ECOSYSTEM_FILE" >/dev/null || status=$?
    [[ "$status" -eq 1 ]]
  done
  # Cron has no snapshot: its existing stopped-app alerts remain intact.
  (unset PM2_DEPLOY_STOPPED_FILE; expect_health 1)
  # Exercise a restart command that succeeds but leaves its target unhealthy.
  for kind in file name; do
    for state in errored "waiting restart"; do
      printf '[{"name":"%s-%s-errored","pm2_env":{"status":"%s","pm_exec_path":"/srv/server.js"}}]' \
        "$SCOPE" "$kind" "$state" > "$FAKE_JLIST"
      KEEP_STATUS="$state" run_restart
      [[ "$STATUS" -eq 0 ]]
      assert_contains "$OUT" "Restarting $SCOPE-$kind-errored: pm2 status=$state"
      assert_contains "$(cat "$PM2_LOG")" "$SCOPE-$kind-errored"
      expect_health 1
    done
  done
  # An app that stops during the build must NOT enter the exemption snapshot.
  printf '[{"name":"%s-file-online","pm2_env":{"status":"online"}}]' "$SCOPE" > "$FAKE_JLIST"
  STOP_AFTER_SNAPSHOT="$SCOPE-file-online" run_restart
  [[ "$STATUS" -eq 0 ]]
  assert_contains "$OUT" "Skipping $SCOPE-file-online: pm2 status=stopped"
  assert_absent "$(cat "$PM2_DEPLOY_STOPPED_FILE")" "$SCOPE-file-online"
  expect_health 1
  # Known-stopped cron must not be re-added as if absent.
  printf '[{"name":"%s-kernel-cron","pm2_env":{"status":"stopped"}}]' "$SCOPE" > "$FAKE_JLIST"
  run_restart
  [[ "$STATUS" -eq 0 ]]
  assert_contains "$OUT" "Skipping $SCOPE-kernel-cron: pm2 status=stopped"
  assert_absent "$(cat "$PM2_LOG")" "$SCOPE-kernel-cron"
  # Empty pm2 is valid: bootstrap cron (and prod-jin), do not exit early.
  printf '[]' > "$FAKE_JLIST"
  run_restart
  [[ "$STATUS" -eq 0 ]]
  assert_contains "$(cat "$PM2_LOG")" "start $ECOSYSTEM_FILE --only $SCOPE-kernel-cron"
  # Reconcile and name-restart failures still fail loudly (#2572).
  printf '[]' > "$FAKE_JLIST"
  FAIL_RESTART=start run_restart
  [[ "$STATUS" -ne 0 ]]
  assert_contains "$OUT" "pm2-reconcile failed"
  printf '[{"name":"%s-name-online","pm2_env":{"status":"online"}}]' "$SCOPE" > "$FAKE_JLIST"
  FAIL_RESTART=restart run_restart
  [[ "$STATUS" -ne 0 ]]
  assert_contains "$(cat "$PM2_LOG")" "restart $SCOPE-name-online"
done

# A cluster name with mixed instance statuses cannot be restarted by name.
printf '[]' > "$WORK/cluster-skip.json"
printf '[{"name":"dev-cluster","pm2_env":{"status":"online"}},{"name":"dev-cluster","pm2_env":{"status":"stopped"}}]' \
  | node "$SCRIPT_DIR/lib/pm2-deploy-state.cjs" dev "$WORK/cluster-skip.json" > "$WORK/cluster-selected"
assert_absent "$(cat "$WORK/cluster-selected")" dev-cluster
# The build phase shares the prod-jin exception but not for dev-jin.
for scope in dev prod; do
  decision="$(printf '[{"name":"%s-jin","pm2_env":{"status":"stopped"}}]' "$scope" \
    | node "$SCRIPT_DIR/lib/pm2-deploy-state.cjs" "$scope" --build "$scope-jin")"
  if [[ "$scope" = prod ]]; then
    [[ "$decision" = restart ]]
  else
    [[ "$decision" = skip ]]
  fi
done

# Failed/malformed/empty/non-array snapshots must never restart dev apps.
SCOPE=dev
export ECOSYSTEM_FILE="$WORK/dev.config.js"
for input in '[]' '' 'not-json' '{}'; do
  printf '%s' "$input" > "$FAKE_JLIST"
  if [[ "$input" = '[]' ]]; then
    FAIL_JLIST=1 run_restart
  else
    run_restart
  fi
  [[ "$STATUS" -ne 0 && ! -s "$PM2_LOG" ]]
done
printf '["dev-file-stopped"]' > "$WORK/skip.json"
export PM2_DEPLOY_STOPPED_FILE="$WORK/skip.json"
printf '[{"name":"dev-file-stopped","pm2_env":{"status":"errored"}}]' > "$FAKE_JLIST"
expect_health 1
printf 'not-json' > "$PM2_DEPLOY_STOPPED_FILE"
expect_health 2
status=0
bash "$SCRIPT_DIR/assert-pm2-listeners.sh" dev "$ECOSYSTEM_FILE" >/dev/null 2>&1 || status=$?
[[ "$status" -eq 2 ]]
printf 'All deploy restart / intentional-stop regression assertions passed.\n'
