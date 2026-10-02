#!/usr/bin/env bash
#
# assert-pm2-listeners.sh — fail the deploy unless every pm2 app's port is held
# by that app's own process tree (#2447).
#
# Background: when pm2 launched `npm start`, a restart killed only the npm
# wrapper; the `next-server` grandchild survived (reparented to init), kept the
# port and served traffic while the fresh pm2 copy crash-looped on EADDRINUSE.
# Nothing noticed because the deploy only checked that pm2 said "online".
#
# For every app in the env's ecosystem file that pm2 currently knows, this
# checks (via `ss -ltnp` and `pm2 jlist`) that:
#   - something is listening on the app's port, and
#   - every listener pid is the app's pm2 pid or a descendant of it.
# A listener whose ancestry never reaches the app's pm2 pid (an orphan, or a
# process owned by another app) fails the check. Apps pm2 doesn't know are
# skipped with a warning — starting them is build.sh's job, not ours.
#
# The check is retried for up to ASSERT_TIMEOUT seconds (default 30) so a slow
# boot after `pm2 restart` isn't a false failure; a crash-looping app with an
# orphan squatter never converges and fails the deploy.
#
# Usage: scripts/assert-pm2-listeners.sh [dev|prod] [ecosystem-file]

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCOPE="${1:-dev}"
case "$SCOPE" in
  dev|prod) ;;
  *)
    echo "assert-pm2-listeners: unknown scope '$SCOPE' (expected dev|prod)" >&2
    exit 2
    ;;
esac
ECOSYSTEM="${2:-$SCRIPT_DIR/../deploy/ecosystem.$SCOPE.config.js}"
TIMEOUT="${ASSERT_TIMEOUT:-30}"
INTERVAL="${ASSERT_INTERVAL:-2}"
MAX_DEPTH=8

if [[ ! -f "$ECOSYSTEM" ]]; then
  echo "assert-pm2-listeners: ecosystem file not found: $ECOSYSTEM" >&2
  exit 2
fi

# "<name> <port>" per app that declares a port via env.PORT or `-p <port>` args.
TARGETS="$(node -e '
  const mod = require(require("path").resolve(process.argv[1]));
  const apps = Array.isArray(mod) ? mod : mod.apps || [];
  for (const app of apps) {
    const fromArgs = /(?:^|\s)-p\s+(\d+)/.exec(app.args || "");
    const port = (app.env && app.env.PORT) || (fromArgs && fromArgs[1]);
    if (app.name && port) console.log(app.name + " " + port);
  }
' "$ECOSYSTEM")" || {
  echo "assert-pm2-listeners: could not load $ECOSYSTEM" >&2
  exit 2
}

# pm2's own pid for process $1 (empty if unknown or not running).
pm2_pid_of() {
  local name="$1"
  pm2 jlist 2>/dev/null | node -e '
    const procs = JSON.parse(require("fs").readFileSync(0) || "[]");
    const match = procs.find((p) => p && p.name === process.argv[1]);
    if (match && match.pid) console.log(match.pid);
  ' "$name" 2>/dev/null || true
  return 0
}

# Does pm2 know a process named $1 at all (running or not)?
pm2_knows() {
  local name="$1" status
  pm2 jlist 2>/dev/null | node -e '
    const procs = JSON.parse(require("fs").readFileSync(0) || "[]");
    process.exit(procs.some((p) => p && p.name === process.argv[1]) ? 0 : 1);
  ' "$name" 2>/dev/null
  status=$?
  return "$status"
}

# Is pid $1 equal to, or a descendant of, pid $2?
is_in_tree() {
  local pid="$1" root="$2" depth=0
  while [[ -n "$pid" && "$pid" != "0" && "$pid" != "1" && "$depth" -lt "$MAX_DEPTH" ]]; do
    [[ "$pid" = "$root" ]] && return 0
    pid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"
    depth=$((depth + 1))
  done
  return 1
}

# Echo a failure reason and return 1, or return 0 when the app is healthy.
check_app() {
  local name="$1" port="$2" app_pid listeners pid
  app_pid="$(pm2_pid_of "$name")"
  if [[ -z "$app_pid" ]]; then
    echo "$name has no running pm2 pid"
    return 1
  fi
  listeners="$(ss -ltnpH "sport = :$port" 2>/dev/null \
    | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u || true)"
  if [[ -z "$listeners" ]]; then
    echo "nothing is listening on :$port (pm2 pid $app_pid)"
    return 1
  fi
  for pid in $listeners; do
    if ! is_in_tree "$pid" "$app_pid"; then
      echo "listener pid $pid on :$port is not a child of pm2 pid $app_pid (orphan or foreign process)"
      return 1
    fi
  done
  return 0
}

FAILED=0
CHECKED=0
while read -r name port; do
  [[ -z "$name" ]] && continue
  if ! pm2_knows "$name"; then
    echo "ℹ️  $name not known to pm2 — skipping listener check"
    continue
  fi
  CHECKED=$((CHECKED + 1))
  waited=0
  while true; do
    if reason="$(check_app "$name" "$port")"; then
      echo "✅ $name :$port — listener is owned by pm2"
      break
    fi
    if [[ "$waited" -ge "$TIMEOUT" ]]; then
      echo "❌ $name :$port — $reason"
      FAILED=$((FAILED + 1))
      break
    fi
    sleep "$INTERVAL"
    waited=$((waited + INTERVAL))
  done
done <<< "$TARGETS"

if [[ "$FAILED" -gt 0 ]]; then
  echo "❌ assert-pm2-listeners ($SCOPE): $FAILED of $CHECKED service(s) have a port not owned by pm2."
  exit 1
fi
echo "✅ assert-pm2-listeners ($SCOPE): all $CHECKED checked service(s) are listening under pm2."
