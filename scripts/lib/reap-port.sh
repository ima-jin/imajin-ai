#!/usr/bin/env bash
# reap-port.sh — shared "free this port of non-pm2 listeners" helper (#2094,
# #2572).
#
# An orphaned server (e.g. the `next-server` grandchild of an `npm start`
# wrapper) can survive `pm2 delete` / `pm2 restart`, get reparented to init and
# keep an app's port. The next `pm2 start` then fails to bind and crash-loops
# while the orphan keeps serving an old build. Originally lived inside
# scripts/build.sh; moved here so scripts/pm2-reconcile.sh can free the port
# right after its own `pm2 delete` (#2572) with the very same logic.
#
# Needs scripts/lib/pm2-owned.sh sourced first (pm2_managed_pids,
# is_pm2_owned, pm2_app_is_online).
#
# Output goes through `reap_log` — echoes by default; callers (build.sh) may
# define their own before sourcing this file to also append to a report.
#
# Tunables (tests set these to 0): REAP_KILL_GRACE (seconds between SIGTERM and
# SIGKILL, default 2), REAP_POLL_INTERVAL (seconds between "is it free yet"
# checks, default 0.5).
#
# Usage (source, don't execute):
#   reap_orphan_port <label> <port> <pm2-name>

if ! declare -F reap_log >/dev/null 2>&1; then
  reap_log() {
    printf '%s\n' "$*"
    return 0
  }
fi

# Print the unique pids listening on TCP port $1 (nothing if none / no ss).
_reap_port_listeners() {
  local port="$1"
  ss -ltnpH "sport = :$port" 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u || true
  return 0
}

# Reap any listener on $port that pm2 doesn't own, then verify (short bounded
# wait) that the port is actually free. Returns 1 only when the port is truly
# stuck AND pm2 doesn't report $name online; returns 0 (with a warning, not an
# error) when the remaining listener turns out to be pm2-owned or pm2 otherwise
# reports the app healthy (#2344).
reap_orphan_port() {
  local app="$1" port="$2" name="$3"
  local pid="" cmd="" listeners="" stray=""
  local grace="${REAP_KILL_GRACE:-2}" interval="${REAP_POLL_INTERVAL:-0.5}"

  if ! command -v ss >/dev/null 2>&1; then
    reap_log "ℹ️  ss not found — skipping orphan-port check for $app (:$port)"
    return 0
  fi

  # Refresh before every use, not just once per restart batch: pm2 can respawn
  # an app (with a brand-new pid) between when PM2_PIDS was last captured and
  # now. A stale snapshot is exactly what produced #2344's false failure.
  # PM2_PIDS is read by is_pm2_owned (scripts/lib/pm2-owned.sh).
  # shellcheck disable=SC2034
  PM2_PIDS="$(pm2_managed_pids)"

  listeners="$(_reap_port_listeners "$port")"
  for pid in $listeners; do
    [[ -z "$pid" ]] && continue
    is_pm2_owned "$pid" && continue
    cmd="$(ps -o cmd= -p "$pid" 2>/dev/null || echo '?')"
    reap_log "⚠️  Orphan on :$port ($app) — pid $pid ($cmd) not owned by pm2. Reaping."
    kill "$pid" 2>/dev/null || true
    sleep "$grace"
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null || true
    fi
  done

  local _attempt
  for _attempt in 1 2 3 4 5; do
    stray=""
    # shellcheck disable=SC2034
    PM2_PIDS="$(pm2_managed_pids)"
    listeners="$(_reap_port_listeners "$port")"
    for pid in $listeners; do
      [[ -z "$pid" ]] && continue
      is_pm2_owned "$pid" || stray="$pid"
    done
    [[ -z "$stray" ]] && return 0
    sleep "$interval"
  done

  cmd="$(ps -o cmd= -p "$stray" 2>/dev/null || echo '?')"
  # A pid we still can't attribute to pm2 is, by itself, an ownership/reporting
  # mismatch, not proof the service is down (#2344) — pm2's own "online" status
  # is the actual health signal. Only fail when pm2 agrees something is wrong.
  if pm2_app_is_online "$name"; then
    reap_log "⚠️  Port $port ($app) still shows pid $stray ($cmd) after reaping, but pm2 reports $name online — treating as pm2-managed, not a failure."
    return 0
  fi

  reap_log "❌ Port $port ($app) still held by pid $stray ($cmd) after reaping, and pm2 does not report $name online — refusing to restart $app."
  return 1
}
