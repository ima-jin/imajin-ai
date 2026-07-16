#!/usr/bin/env bash
#
# reap-orphans.sh — kill orphaned Node processes squatting on managed app ports.
#
# Background: apps are supposed to run only under pm2. If someone hand-starts an
# app (e.g. `npm start` / `node server.js` while debugging) and forgets it, that
# process keeps the port bound. pm2's real process for that app can then never
# bind the port, so it crash-loops silently while the stale orphan serves an old
# build. This script finds any process listening on a managed port whose PID is
# NOT owned by pm2, and kills it — so the next `pm2 restart` can take the port.
#
# Safe by design:
#   - Only touches PIDs that are (a) listening on a port in ENV_PORTS and
#     (b) NOT present in `pm2 jlist`. pm2-managed processes are never killed.
#   - Scope is chosen by the first arg: "dev" or "prod" (defaults to dev).
#
# Usage: scripts/reap-orphans.sh [dev|prod]

set -euo pipefail

SCOPE="${1:-dev}"

# Managed port ranges per convention (see TOOLS.md):
#   dev  = 3xxx, prod = 7xxx
case "$SCOPE" in
  dev)
    PORTS=(3000 3006 3100 3101 3102 3103 3104 3400 3401)
    ;;
  prod)
    PORTS=(7000 7006 7100 7101 7102 7103 7104 7400 7401)
    ;;
  *)
    echo "reap-orphans: unknown scope '$SCOPE' (expected dev|prod)" >&2
    exit 2
    ;;
esac

# Collect the set of PIDs pm2 currently manages.
PM2_PIDS="$(pm2 jlist 2>/dev/null | node -e '
  const procs = JSON.parse(require("fs").readFileSync(0) || "[]");
  const pids = procs
    .map((p) => (p && p.pid) ? String(p.pid) : "")
    .filter(Boolean);
  console.log(pids.join(" "));
' 2>/dev/null || echo "")"

is_pm2_pid() {
  local pid="$1"
  for managed in $PM2_PIDS; do
    if [ "$pid" = "$managed" ]; then
      return 0
    fi
  done
  return 1
}

KILLED=0
for port in "${PORTS[@]}"; do
  # PIDs listening on this port (LISTEN only). ss avoids lsof dependency.
  LISTENERS="$(ss -ltnpH "sport = :$port" 2>/dev/null \
    | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u || true)"

  for pid in $LISTENERS; do
    [ -z "$pid" ] && continue
    if is_pm2_pid "$pid"; then
      continue
    fi
    CMD="$(ps -o cmd= -p "$pid" 2>/dev/null || echo '?')"
    echo "⚠️  Orphan on :$port — pid $pid ($CMD) not owned by pm2. Reaping."
    kill "$pid" 2>/dev/null || true
    # Give it a moment to exit gracefully, then force if still alive.
    sleep 2
    if kill -0 "$pid" 2>/dev/null; then
      echo "   pid $pid ignored SIGTERM; sending SIGKILL."
      kill -9 "$pid" 2>/dev/null || true
    fi
    KILLED=$((KILLED + 1))
  done
done

if [ "$KILLED" -eq 0 ]; then
  echo "✅ reap-orphans ($SCOPE): no orphaned port squatters found."
else
  echo "✅ reap-orphans ($SCOPE): reaped $KILLED orphan(s)."
fi
