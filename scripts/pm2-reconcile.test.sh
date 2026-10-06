#!/usr/bin/env bash
# pm2-reconcile.test.sh — end-to-end coverage for scripts/pm2-reconcile.sh
# (#2547).
#
# Runs the real script with `pm2` faked via a PATH shim: `pm2 jlist` replays
# $FAKE_JLIST and every other pm2 call is appended to $PM2_LOG, so each
# scenario asserts on exactly which pm2 commands were issued. Covers:
#   - the #2547 incident: a process stored as `npm` while the ecosystem now
#     declares the next binary must be deleted and started from the file, NOT
#     `restart`ed (which would keep `npm` and run `npm start -p <port>`);
#   - a process whose stored exec already matches is only startOrRestarted;
#   - an app missing from pm2 is started from the file;
#   - an interpreter mismatch recreates the app;
#   - a bare PATH command (`npm`) stored as /usr/bin/npm counts as a match;
#   - names the ecosystem doesn't declare are skipped, not touched;
#   - a failing `pm2 start` / `pm2 delete` fails the run;
#   - usage errors exit 2;
#   - a `pm2 jlist` far larger than MAX_ARG_STRLEN (128 KiB) is classified
#     correctly: it must reach node through a file, not env/argv (#2603);
#   - unparseable `pm2 jlist` output fails every app (node exit 3) without
#     issuing any pm2 start/delete;
#   - the jlist temp file is removed on every run;
#   - #2572: after `pm2 delete` (and before `pm2 start`) an orphan still
#     holding the app's port is reaped, the app is NOT started when the port
#     cannot be freed, and apps without a port never touch `ss`/`kill`;
#   - #2572: a missing pm2 binary exits 2 before anything runs, and a failing
#     `pm2 jlist` fails the run instead of reading as "every app is absent".
#
# Usage: scripts/pm2-reconcile.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RECONCILE="$SCRIPT_DIR/pm2-reconcile.sh"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/pm2-reconcile-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
FAKE_BIN="$WORK/bin"
mkdir -p "$FAKE_BIN"

if ! command -v node >/dev/null 2>&1; then
  echo "node not found on PATH — cannot run tests" >&2
  exit 1
fi

NEXT=node_modules/next/dist/bin/next
cat > "$WORK/eco.config.js" <<EOF
module.exports = { apps: [
  { name: 't-next', cwd: '/srv/t-next', script: '$NEXT', args: 'start -p 3104', interpreter: 'node' },
  { name: 't-kernel', cwd: '/srv/t-kernel', script: 'server.js', args: '-p 3000', interpreter: 'node' },
  { name: 't-wrapped', cwd: '/srv/t-wrapped', script: 'npm', args: 'start' },
  { name: 't-new', cwd: '/srv/t-new', script: '$NEXT', args: 'start -p 3105', interpreter: 'node' },
] };
EOF

# EVENT_LOG records, in order, the pm2 delete/start calls, every pid `kill` is
# asked to signal, and whether the port was still held when pm2 start ran —
# so the #2572 ordering (delete -> free port -> start) is asserted exactly.
cat > "$FAKE_BIN/pm2" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" = "jlist" ]]; then
  [[ "${FAKE_PM2_FAIL_JLIST:-}" = "true" ]] && exit 1
  cat "$FAKE_JLIST"
  exit 0
fi
echo "$*" >> "$PM2_LOG"
case "$1" in
  start)
    echo "start held=$([[ -e "$PORT_HELD_FILE" ]] && echo yes || echo no)" >> "$EVENT_LOG"
    [[ "${FAKE_PM2_FAIL_START:-}" = "true" ]] && exit 1
    ;;
  delete)
    echo "delete" >> "$EVENT_LOG"
    [[ "${FAKE_PM2_FAIL_DELETE:-}" = "true" ]] && exit 1
    ;;
esac
exit 0
EOF
chmod +x "$FAKE_BIN/pm2"

# $PORT_HELD_FILE ("<port> <pid>") models an orphan squatting on a port. Absent
# file = nothing listens anywhere.
cat > "$FAKE_BIN/ss" <<'EOF'
#!/usr/bin/env bash
echo "ss $*" >> "$SS_LOG"
[[ -e "$PORT_HELD_FILE" ]] || exit 0
read -r held_port held_pid < "$PORT_HELD_FILE"
case "$*" in
  *":$held_port"*) echo "LISTEN 0 511 *:$held_port *:* users:((\"next-server\",pid=$held_pid,fd=19))" ;;
esac
EOF
chmod +x "$FAKE_BIN/ss"

# The orphan is parented to init, so is_pm2_owned() does not claim it.
cat > "$FAKE_BIN/ps" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *ppid=*) echo 1 ;;
  *) echo "next-server (v14)" ;;
esac
EOF
chmod +x "$FAKE_BIN/ps"

# `kill` is a bash builtin, so run_case runs the script with it disabled (see
# there). The shim frees the port when FAKE_KILL_FREES=true; `kill -0` reports
# the pid dead exactly when the port has been freed.
cat > "$FAKE_BIN/kill" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" = "-0" ]]; then
  [[ -e "$PORT_HELD_FILE" ]] && exit 0
  exit 1
fi
for arg in "$@"; do
  case "$arg" in
    -*) ;;
    *) echo "kill $arg" >> "$EVENT_LOG"; echo "$arg" >> "$KILL_LOG" ;;
  esac
done
[[ "${FAKE_KILL_FREES:-}" = "true" ]] && rm -f "$PORT_HELD_FILE"
exit 0
EOF
chmod +x "$FAKE_BIN/kill"

printf '#!/usr/bin/env bash\nexit 0\n' > "$FAKE_BIN/sleep"
chmod +x "$FAKE_BIN/sleep"

PATH="$FAKE_BIN:$PATH"
export PATH
export FAKE_JLIST="$WORK/jlist.json"
export PM2_LOG="$WORK/pm2.log"
export EVENT_LOG="$WORK/events.log"
export KILL_LOG="$WORK/kills.log"
export SS_LOG="$WORK/ss.log"
export PORT_HELD_FILE="$WORK/port-held"
export PM2_HOME="$WORK/pm2-home"
export REAP_KILL_GRACE=0 REAP_POLL_INTERVAL=0

FAILURES=0

# The script's temp files go here, so each run can assert it left none behind.
SCRIPT_TMP="$WORK/script-tmp"
mkdir -p "$SCRIPT_TMP"

# proc <name> <pm_exec_path> <exec_interpreter>
proc() {
  local proc_name="$1" exec_path="$2" interpreter="$3"
  printf '{"name":"%s","pm2_env":{"pm_exec_path":"%s","exec_interpreter":"%s"}}' \
    "$proc_name" "$exec_path" "$interpreter"
  return 0
}

# filler <count> <pad-bytes>: <count> comma-joined unrelated processes, each
# carrying <pad-bytes> of env noise, to inflate the jlist the way a real pm2
# (full env per process) does.
filler() {
  local count="$1" pad="$2"
  node -e '
    const [count, pad] = process.argv.slice(1).map(Number);
    const noise = "x".repeat(pad);
    const procs = [];
    for (let i = 0; i < count; i++) {
      procs.push(JSON.stringify({
        name: "filler-" + i,
        pm2_env: { pm_exec_path: "/usr/bin/filler", exec_interpreter: "none", env: { NOISE: noise } },
      }));
    }
    process.stdout.write(procs.join(","));
  ' "$count" "$pad"
  return 0
}

# run_case <label> <expected-exit> <names...>; reads $JLIST_JSON, $EXPECT_LOG
# (newline-separated exact pm2 calls, in order), optional $EXPECT_OUT, optional
# $PORT_HELD ("<port> <pid>": an orphan squatting on that port) and optional
# $EXPECT_EVENTS (exact ordered delete/kill/start events).
run_case() {
  local label="$1" expected="$2" out status=0
  shift 2
  printf '[%s]' "$JLIST_JSON" > "$FAKE_JLIST"
  : > "$PM2_LOG"
  : > "$EVENT_LOG"
  : > "$KILL_LOG"
  : > "$SS_LOG"
  rm -f "$PORT_HELD_FILE"
  if [[ -n "${PORT_HELD:-}" ]]; then
    echo "$PORT_HELD" > "$PORT_HELD_FILE"
  fi
  # `enable -n kill` disables the bash builtin so the script's bare `kill`
  # resolves to the shim above; sourcing keeps that in effect for the whole run.
  out="$(TMPDIR="$SCRIPT_TMP" bash -c 'enable -n kill; source "$1" "${@:2}"' _ "$RECONCILE" "$WORK/eco.config.js" "$@" 2>&1)" || status=$?
  echo "$out"
  if [[ "$status" -ne "$expected" ]]; then
    echo "❌ $label: expected exit $expected, got $status"
    FAILURES=$((FAILURES + 1))
    return
  fi
  if [[ -n "$(ls -A "$SCRIPT_TMP")" ]]; then
    echo "❌ $label: temp files left behind:"
    ls -A "$SCRIPT_TMP"
    FAILURES=$((FAILURES + 1))
    return
  fi
  if [[ "$(cat "$PM2_LOG")" != "$EXPECT_LOG" ]]; then
    echo "❌ $label: unexpected pm2 calls. expected:"
    echo "$EXPECT_LOG"
    echo "actual:"
    cat "$PM2_LOG"
    FAILURES=$((FAILURES + 1))
    return
  fi
  if [[ -n "${EXPECT_EVENTS+x}" && "$(cat "$EVENT_LOG")" != "$EXPECT_EVENTS" ]]; then
    echo "❌ $label: unexpected delete/kill/start order. expected:"
    echo "$EXPECT_EVENTS"
    echo "actual:"
    cat "$EVENT_LOG"
    FAILURES=$((FAILURES + 1))
    return
  fi
  local needle
  for needle in ${EXPECT_OUT:+"$EXPECT_OUT"}; do
    if ! grep -qF -- "$needle" <<< "$out"; then
      echo "❌ $label: output is missing '$needle'"
      FAILURES=$((FAILURES + 1))
      return
    fi
  done
  echo "✅ $label"
}

ECO="$WORK/eco.config.js"

# 1. The #2547 incident: stored as npm, ecosystem now declares the next binary.
JLIST_JSON="$(proc t-next /usr/bin/npm none)"
EXPECT_LOG="delete t-next
start $ECO --only t-next --update-env"
EXPECT_OUT="recreating"
run_case "stored npm vs declared next binary: delete + start, never restart (#2547)" 0 t-next

# 2. Stored exec already matches -> plain startOrRestart from the file.
JLIST_JSON="$(proc t-next "/srv/t-next/$NEXT" node)"
EXPECT_LOG="startOrRestart $ECO --only t-next --update-env"
EXPECT_OUT=""
run_case "matching stored exec is only restarted from the file" 0 t-next

# 3. Absent from pm2 -> started from the file, nothing deleted.
JLIST_JSON=""
EXPECT_LOG="start $ECO --only t-new --update-env"
EXPECT_OUT="not in pm2"
run_case "app absent from pm2 is started from the ecosystem" 0 t-new

# 4. Same path, different interpreter -> recreate.
JLIST_JSON="$(proc t-kernel /srv/t-kernel/server.js none)"
EXPECT_LOG="delete t-kernel
start $ECO --only t-kernel --update-env"
EXPECT_OUT="stored interpreter none != declared node"
run_case "interpreter mismatch recreates the app" 0 t-kernel

# 5. Bare PATH command stored as its resolved path still matches.
JLIST_JSON="$(proc t-wrapped /usr/bin/npm none)"
EXPECT_LOG="startOrRestart $ECO --only t-wrapped --update-env"
EXPECT_OUT=""
run_case "bare command (npm) stored as /usr/bin/npm is a match" 0 t-wrapped

# 6. Mixed batch: mismatch recreated, matches batched into one startOrRestart.
JLIST_JSON="$(proc t-next /usr/bin/npm none),$(proc t-kernel /srv/t-kernel/server.js node),$(proc t-wrapped /usr/bin/npm none)"
EXPECT_LOG="delete t-next
start $ECO --only t-next --update-env
startOrRestart $ECO --only t-kernel,t-wrapped --update-env"
EXPECT_OUT=""
run_case "mixed batch recreates mismatches and restarts the rest together" 0 t-next t-kernel t-wrapped

# 7. Undeclared names are skipped untouched.
JLIST_JSON="$(proc t-ghost /usr/bin/npm none)"
EXPECT_LOG=""
EXPECT_OUT="not declared"
run_case "name missing from the ecosystem is skipped" 0 t-ghost

# 8. Failures propagate.
JLIST_JSON="$(proc t-next /usr/bin/npm none)"
EXPECT_LOG="delete t-next
start $ECO --only t-next --update-env"
EXPECT_OUT=""
FAKE_PM2_FAIL_START=true run_case "failing pm2 start fails the run" 1 t-next

EXPECT_LOG="delete t-next"
FAKE_PM2_FAIL_DELETE=true run_case "failing pm2 delete fails the run and does not start" 1 t-next

# 9. #2603: a jlist well over 256 KiB (2x the 128 KiB MAX_ARG_STRLEN) must be
#    classified correctly. Handing it to node via env/argv fails every app with
#    "Argument list too long". One run covers every verdict.
JLIST_JSON="$(proc t-next /usr/bin/npm none),$(proc t-kernel /srv/t-kernel/server.js node),$(filler 200 2048),$(proc t-wrapped /usr/bin/npm none)"
if [[ "${#JLIST_JSON}" -le 262144 ]]; then
  echo "❌ test setup: synthetic jlist is only ${#JLIST_JSON} bytes, need > 262144"
  FAILURES=$((FAILURES + 1))
fi
EXPECT_LOG="delete t-next
start $ECO --only t-next --update-env
start $ECO --only t-new --update-env
startOrRestart $ECO --only t-kernel,t-wrapped --update-env"
EXPECT_OUT="stored exec /usr/bin/npm != declared /srv/t-next/$NEXT"
run_case "jlist > 256 KiB: mismatch/match/absent/undeclared all classified (#2603)" 0 t-next t-kernel t-new t-ghost t-wrapped

# 10. Unusable pm2 output (node exit 3): every app fails, nothing is started or
#    deleted.
JLIST_JSON="this is not json"
EXPECT_LOG=""
EXPECT_OUT="t-next: could not compare ecosystem with pm2 state"
run_case "unparseable pm2 jlist fails every app without touching pm2" 1 t-next t-kernel

# 11. #2572: the port is freed between `pm2 delete` and `pm2 start`. The
#     `npm start` tree's next-server (pid 9001) outlives the delete and holds
#     :3104; it must be killed before the new definition starts into it.
JLIST_JSON="$(proc t-next /usr/bin/npm none)"
PORT_HELD="3104 9001"
EXPECT_LOG="delete t-next
start $ECO --only t-next --update-env"
EXPECT_EVENTS="delete
kill 9001
start held=no"
EXPECT_OUT="Orphan on :3104"
FAKE_KILL_FREES=true run_case "orphan on the port after delete is reaped before start (#2572)" 0 t-next

# Same, for an app whose port comes from env.PORT (no -p in args).
cat > "$WORK/eco-envport.config.js" <<EOF2
module.exports = { apps: [
  { name: 't-envport', cwd: '/srv/t-envport', script: 'server.js', interpreter: 'node', env: { PORT: 3000 } },
] };
EOF2
JLIST_JSON="$(proc t-envport /srv/t-envport/other.js node)"
PORT_HELD="3000 9002"
EXPECT_LOG="delete t-envport
start $WORK/eco-envport.config.js --only t-envport --update-env"
EXPECT_EVENTS="delete
kill 9002
start held=no"
EXPECT_OUT="Orphan on :3000"
printf '[%s]' "$JLIST_JSON" > "$FAKE_JLIST"
: > "$PM2_LOG"; : > "$EVENT_LOG"; : > "$KILL_LOG"; : > "$SS_LOG"
echo "$PORT_HELD" > "$PORT_HELD_FILE"
status=0
out="$(FAKE_KILL_FREES=true TMPDIR="$SCRIPT_TMP" bash -c 'enable -n kill; source "$1" "${@:2}"' _ "$RECONCILE" "$WORK/eco-envport.config.js" t-envport 2>&1)" || status=$?
echo "$out"
if [[ "$status" -eq 0 && "$(cat "$EVENT_LOG")" = "$EXPECT_EVENTS" && "$(cat "$PM2_LOG")" = "$EXPECT_LOG" ]] && grep -qF "$EXPECT_OUT" <<< "$out"; then
  echo "✅ port declared via env.PORT is freed before start (#2572)"
else
  echo "❌ env.PORT app: exit $status; events:"; cat "$EVENT_LOG"
  FAILURES=$((FAILURES + 1))
fi
PORT_HELD=""

# An orphan that survives SIGTERM and SIGKILL: the app must NOT be started into
# a held port, and the run fails.
JLIST_JSON="$(proc t-next /usr/bin/npm none)"
PORT_HELD="3104 9001"
EXPECT_LOG="delete t-next"
EXPECT_EVENTS="delete
kill 9001
kill 9001"
EXPECT_OUT="still held"
FAKE_KILL_FREES=false run_case "port that cannot be freed fails the run and does not start (#2572)" 1 t-next

# Apps absent from pm2 get the same pre-start port check.
JLIST_JSON=""
PORT_HELD="3105 9003"
EXPECT_LOG="start $ECO --only t-new --update-env"
EXPECT_EVENTS="kill 9003
start held=no"
EXPECT_OUT="Orphan on :3105"
FAKE_KILL_FREES=true run_case "orphan on an absent app's port is reaped before start (#2572)" 0 t-new

# A matching app is only restarted: its port is held by its own pm2 process,
# which must never be reaped or even looked up.
JLIST_JSON="$(proc t-next "/srv/t-next/$NEXT" node)"
PORT_HELD="3104 9001"
EXPECT_LOG="startOrRestart $ECO --only t-next --update-env"
EXPECT_EVENTS=""
EXPECT_OUT=""
FAKE_KILL_FREES=true run_case "matching app's port is not reaped (#2572)" 0 t-next

# An app without a port (t-wrapped: npm start, no env.PORT, no -p) never
# consults ss or kill.
JLIST_JSON="$(proc t-wrapped /usr/bin/node none)"
PORT_HELD="3104 9001"
EXPECT_LOG="delete t-wrapped
start $ECO --only t-wrapped --update-env"
EXPECT_EVENTS="delete
start held=yes"
EXPECT_OUT="recreating"
FAKE_KILL_FREES=true run_case "app without a port is recreated without any port reaping (#2572)" 0 t-wrapped
if [[ -s "$SS_LOG" ]]; then
  echo "❌ app without a port consulted ss: $(cat "$SS_LOG")"
  FAILURES=$((FAILURES + 1))
else
  echo "✅ app without a port never consulted ss"
fi
unset PORT_HELD EXPECT_EVENTS

# 12. #2572: a failing `pm2 jlist` must not read as "every app is absent"
#     (which would `pm2 start` them all over whatever is running).
JLIST_JSON="[]"
EXPECT_LOG=""
EXPECT_OUT="'pm2 jlist' failed"
FAKE_PM2_FAIL_JLIST=true run_case "failing pm2 jlist fails the run without starting anything" 1 t-next t-new

# 13. #2572 install check: pm2 missing from the host exits 2 before anything
#     else, naming what is missing. PATH holds only the few tools the script
#     needs to reach its preflight, so pm2 is genuinely not found.
NOPM2_BIN="$WORK/nopm2-bin"
mkdir -p "$NOPM2_BIN"
for tool in node dirname hostname; do
  ln -sf "$(command -v "$tool")" "$NOPM2_BIN/$tool"
done
BASH_BIN="$(command -v bash)"
status=0
out="$(PATH="$NOPM2_BIN" "$BASH_BIN" "$RECONCILE" "$ECO" t-next 2>&1)" || status=$?
echo "$out"
if [[ "$status" -eq 2 ]] && grep -qF "'pm2' is not installed" <<< "$out"; then
  echo "✅ pm2 missing from the host exits 2 with a clear message (#2572)"
else
  echo "❌ pm2 missing: expected exit 2 naming pm2, got $status"
  FAILURES=$((FAILURES + 1))
fi

# 14. Usage errors.
status=0
bash "$RECONCILE" >/dev/null 2>&1 || status=$?
if [[ "$status" -eq 2 ]]; then echo "✅ no args exits 2"; else echo "❌ no args: got $status"; FAILURES=$((FAILURES + 1)); fi

status=0
bash "$RECONCILE" "$WORK/missing.config.js" t-next >/dev/null 2>&1 || status=$?
if [[ "$status" -eq 2 ]]; then echo "✅ missing ecosystem file exits 2"; else echo "❌ missing ecosystem: got $status"; FAILURES=$((FAILURES + 1)); fi

if [[ "$FAILURES" -gt 0 ]]; then
  echo "$FAILURES assertion(s) failed."
  exit 1
fi
echo "All pm2-reconcile.sh end-to-end assertions passed."
