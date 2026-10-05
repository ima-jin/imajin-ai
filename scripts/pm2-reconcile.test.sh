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
#   - the jlist temp file is removed on every run.
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

cat > "$FAKE_BIN/pm2" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" = "jlist" ]]; then
  cat "$FAKE_JLIST"
  exit 0
fi
echo "$*" >> "$PM2_LOG"
case "$1" in
  start)  [[ "${FAKE_PM2_FAIL_START:-}" = "true" ]] && exit 1 ;;
  delete) [[ "${FAKE_PM2_FAIL_DELETE:-}" = "true" ]] && exit 1 ;;
esac
exit 0
EOF
chmod +x "$FAKE_BIN/pm2"

PATH="$FAKE_BIN:$PATH"
export PATH
export FAKE_JLIST="$WORK/jlist.json"
export PM2_LOG="$WORK/pm2.log"

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
# (newline-separated exact pm2 calls, in order) and optional $EXPECT_OUT.
run_case() {
  local label="$1" expected="$2" out status=0
  shift 2
  printf '[%s]' "$JLIST_JSON" > "$FAKE_JLIST"
  : > "$PM2_LOG"
  out="$(TMPDIR="$SCRIPT_TMP" bash "$RECONCILE" "$WORK/eco.config.js" "$@" 2>&1)" || status=$?
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

# 11. Usage errors.
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
