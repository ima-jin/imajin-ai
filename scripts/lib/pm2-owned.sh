#!/usr/bin/env bash
# pm2-owned.sh — shared pm2 process-ownership check (#2237).
#
# A listener pid is "pm2-owned" if it, or any ancestor up to a bounded depth,
# is a pid pm2 currently manages. This ancestor walk (not an exact pid match)
# is required because pm2 fork-mode tracks the wrapper process it spawned
# (e.g. `next start`) while the port is actually held by a grandchild (e.g.
# the `next-server` process, or tsx→node for corpus). Matching only the exact
# listener pid against `pm2 jlist` misreads every healthy multi-process app
# as an orphan, gets it reaped, and pm2 respawns it seconds later.
#
# Originally introduced in scripts/reap-orphans.sh (commit 10eee44e) and
# duplicated (incorrectly, as an exact-match-only check) in scripts/build.sh.
# Both scripts now source this file so the logic can't drift again.
#
# Usage (source, don't execute):
#   source "$(dirname "$0")/lib/pm2-owned.sh"
#   PM2_PIDS="$(pm2_managed_pids)"
#   is_pm2_owned "$pid" && echo "owned"

# Space-separated list of PIDs pm2 currently manages.
pm2_managed_pids() {
  pm2 jlist 2>/dev/null | node -e '
    const procs = JSON.parse(require("fs").readFileSync(0) || "[]");
    const pids = procs
      .map((p) => (p && p.pid) ? String(p.pid) : "")
      .filter(Boolean);
    console.log(pids.join(" "));
  ' 2>/dev/null || echo ""
  return 0
}

# Exact-match test against the global PM2_PIDS list (set by the caller via
# pm2_managed_pids before calling is_pm2_owned).
_pm2_pid_in_managed_list() {
  local pid="$1" managed
  for managed in $PM2_PIDS; do
    if [[ "$pid" = "$managed" ]]; then
      return 0
    fi
  done
  return 1
}

# The PM2 "God Daemon" is pm2's own root process — every process pm2 launches
# (fork or cluster mode) is a direct child of it. Prefer the pid file pm2
# itself writes ($PM2_HOME/pm2.pid, default ~/.pm2/pm2.pid); fall back to a
# name match if that file is missing or stale. Empty output means "unknown",
# which callers must treat as "can't use this signal", not "not pm2".
pm2_god_daemon_pid() {
  local pid_file="${PM2_HOME:-$HOME/.pm2}/pm2.pid" pid=""
  if [[ -f "$pid_file" ]]; then
    pid="$(tr -d '[:space:]' < "$pid_file" 2>/dev/null || true)"
  fi
  if [[ -z "$pid" ]]; then
    pid="$(pgrep -f 'PM2 v[0-9][0-9.]*: God Daemon' 2>/dev/null | head -1 || true)"
  fi
  printf '%s' "$pid"
}

# Is $1 owned by pm2, walking up the ancestor chain up to 6 levels? Expects
# the global PM2_PIDS to already be populated (see pm2_managed_pids above).
#
# Two independent signals count as "owned", checked at every hop:
#   (a) the pid is an exact match in PM2_PIDS (pm2 jlist's reported pids), or
#   (b) the pid's own parent is the PM2 God Daemon — i.e. this pid is itself
#       a process pm2 directly launched, even if our PM2_PIDS snapshot is
#       momentarily stale (e.g. pm2 just respawned the app with a new pid
#       between our snapshot and this check — see #2344).
# (a) alone previously missed real incidents where pm2 jlist raced a reap;
# (b) is a strictly cheaper, snapshot-independent corroboration of the same
# fact and never fires for a genuine orphan, whose ancestry never touches
# the daemon at all.
is_pm2_owned() {
  local pid="$1" depth=0 ppid god_pid
  god_pid="$(pm2_god_daemon_pid)"
  while [[ -n "$pid" && "$pid" != "0" && "$pid" != "1" && "$depth" -lt 6 ]]; do
    if _pm2_pid_in_managed_list "$pid"; then
      return 0
    fi
    ppid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"
    if [[ -n "$god_pid" && "$ppid" = "$god_pid" ]]; then
      return 0
    fi
    pid="$ppid"
    depth=$((depth + 1))
  done
  return 1
}

# Does pm2 currently know a process named $1 (regardless of pid)?
pm2_has_name() {
  local name="$1" status
  pm2 jlist 2>/dev/null | node -e '
    const procs = JSON.parse(require("fs").readFileSync(0) || "[]");
    process.exit(procs.some((p) => p && p.name === process.argv[1]) ? 0 : 1);
  ' "$name" 2>/dev/null
  status=$?
  return "$status"
}

# Does pm2 report process $1 as currently "online"? Used as the authoritative
# health signal when a port-reap check can't cleanly attribute a listener pid
# (#2344): if pm2 itself says the app is online, an unmatched listener pid is
# an ownership/reporting mismatch, not evidence the service is down.
pm2_app_is_online() {
  local name="$1" status
  pm2 jlist 2>/dev/null | node -e '
    const procs = JSON.parse(require("fs").readFileSync(0) || "[]");
    const name = process.argv[1];
    const match = procs.find((p) => p && p.name === name);
    const status = match && match.pm2_env && match.pm2_env.status;
    process.exit(status === "online" ? 0 : 1);
  ' "$name" 2>/dev/null
  status=$?
  return "$status"
}

# Does the ecosystem config file at $2 declare an app named $1?
ecosystem_has_app() {
  local name="$1" file="$2" status
  [[ -f "$file" ]] || return 1
  node -e '
    const path = process.argv[1];
    const name = process.argv[2];
    let apps;
    try {
      const mod = require(path);
      apps = Array.isArray(mod) ? mod : mod.apps;
    } catch {
      process.exit(1);
    }
    process.exit(Array.isArray(apps) && apps.some((a) => a && a.name === name) ? 0 : 1);
  ' "$file" "$name" 2>/dev/null
  status=$?
  return "$status"
}
