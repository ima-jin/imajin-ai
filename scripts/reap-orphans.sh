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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/pm2-owned.sh
source "$SCRIPT_DIR/lib/pm2-owned.sh"

SCOPE="${1:-dev}"

# Managed port ranges per convention (see TOOLS.md):
#   dev  = 3xxx, prod = 7xxx
case "$SCOPE" in
  dev)
    PORTS=(3000 3006 3100 3101 3102 3103 3104 3400 3401)
    ;;
  prod)
    PORTS=(7000 7001 7002 7003 7004 7005 7006 7007 7008 7009 7100 7101 7102 7103 7104 7400 7401)
    ;;
  *)
    echo "reap-orphans: unknown scope '$SCOPE' (expected dev|prod)" >&2
    exit 2
    ;;
esac

# PM2_PIDS (used by is_pm2_owned, from lib/pm2-owned.sh, which walks the
# ancestor chain up to 6 levels — Next.js apps run as `next start`, the pid
# pm2 tracks, which forks a `next-server` child that actually holds the
# port, so an exact-pid match alone would misread every healthy Next app as
# an orphan) is (re)populated at the top of each port iteration below.

KILLED=0
for port in "${PORTS[@]}"; do
  # Refresh per port, not just once for the whole scan: pm2 may have
  # restarted an app (new pid) between ports, or as a side effect of an
  # earlier reap in this same pass (#2344).
  PM2_PIDS="$(pm2_managed_pids)"

  # PIDs listening on this port (LISTEN only). ss avoids lsof dependency.
  LISTENERS="$(ss -ltnpH "sport = :$port" 2>/dev/null \
    | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u || true)"

  for pid in $LISTENERS; do
    [[ -z "$pid" ]] && continue
    if is_pm2_owned "$pid"; then
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

if [[ "$KILLED" -eq 0 ]]; then
  echo "✅ reap-orphans ($SCOPE): no orphaned port squatters found."
else
  echo "✅ reap-orphans ($SCOPE): reaped $KILLED orphan(s)."
fi
