#!/usr/bin/env bash
#
# check-pm2-status.sh — alert when a pm2 app is parked `errored` or `stopped`
# (#2572).
#
# Background: after `max_restarts` consecutive crashes pm2 gives up and parks
# the app as `errored`; an app can also end up `stopped` (a manual `pm2 stop`,
# a failed reconcile). Neither moves pm2's restart counter any more, so
# check-pm2-restarts.sh — which only sees the counter climb — goes quiet, and
# nothing tells anyone the service is down. This is the companion check: it
# reads `pm2 jlist` and flags every app the env's ecosystem file declares whose
# status is `errored` or `stopped`.
#
# Deliberately NOT flagged:
#   - `stopped` apps the ecosystem declares with `autorestart: false` — one-shot
#     jobs legitimately sit `stopped` after a clean exit (an `errored` one-shot
#     is still flagged);
#   - transient states (`launching`, `stopping`, `waiting restart`) — a crash
#     loop in progress is check-pm2-restarts.sh's job;
#   - apps pm2 doesn't know at all (declared but not hosted here, e.g. corpus
#     on gx10).
#
# Meant to run every minute or so (scripts/pm2-health-check.sh does, installed
# by scripts/install-pm2-health-cron.sh from the deploy workflows). An app stays
# reported (exit 1) for as long as it is parked, but the webhook is only POSTed
# when an (app, status) pair is new or its last alert is older than the repeat
# interval, so a parked app does not page every minute.
#
# Env:
#   STATUS_ALERT_WEBHOOK   optional URL; receives {"text": "..."} on alert
#                          (falls back to RESTART_ALERT_WEBHOOK so one webhook
#                          serves both checks)
#   STATUS_ALERT_REPEAT    seconds before re-sending the same alert (default 3600)
#   STATUS_ALERT_STATE     state file (default ~/.cache/imajin/pm2-status.<scope>.json)
#   STATUS_ALERT_NOW       override "now" (epoch seconds) — tests only
#
# Usage: scripts/check-pm2-status.sh [dev|prod] [ecosystem-file]
# Exit:  0 healthy, 1 errored/stopped app found, 2 usage / environment error.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/alert-webhook.sh
source "$SCRIPT_DIR/lib/alert-webhook.sh"
# shellcheck source=scripts/lib/pm2-preflight.sh
source "$SCRIPT_DIR/lib/pm2-preflight.sh"

SCOPE="${1:-dev}"
case "$SCOPE" in
  dev|prod) ;;
  *)
    echo "check-pm2-status: unknown scope '$SCOPE' (expected dev|prod)" >&2
    exit 2
    ;;
esac
ECOSYSTEM="${2:-$SCRIPT_DIR/../deploy/ecosystem.$SCOPE.config.js}"
REPEAT="${STATUS_ALERT_REPEAT:-3600}"
STATE="${STATUS_ALERT_STATE:-${HOME:-/tmp}/.cache/imajin/pm2-status.$SCOPE.json}"
WEBHOOK="${STATUS_ALERT_WEBHOOK:-${RESTART_ALERT_WEBHOOK:-}}"

if ! [[ "$REPEAT" =~ ^[0-9]+$ ]]; then
  echo "check-pm2-status: STATUS_ALERT_REPEAT must be a non-negative integer (got '$REPEAT')" >&2
  exit 2
fi
pm2_preflight check-pm2-status "$ECOSYSTEM" || exit 2
mkdir -p "$(dirname "$STATE")" || exit 2

# `pm2 jlist` carries every process's full env and can outgrow the kernel's
# per-string exec limit, so it goes to node through a temp file (#2603).
JLIST_FILE="$(mktemp "${TMPDIR:-/tmp}/check-pm2-status-jlist.XXXXXX")" || {
  echo "check-pm2-status: could not create a temp file" >&2
  exit 2
}
trap 'rm -f "$JLIST_FILE"' EXIT
if ! pm2 jlist 2>/dev/null > "$JLIST_FILE"; then
  echo "check-pm2-status: 'pm2 jlist' failed" >&2
  exit 2
fi

# Prints one "<name> <status> <notify|quiet>" line per parked app and rewrites
# the state file (an app that recovered drops out, so a relapse alerts again).
# Exit 3 = could not load the ecosystem file or pm2 output.
PROBLEMS="$(
  node -e '
    const fs = require("fs");
    const path = require("path");
    const [ecosystem, jlistFile, statePath, repeatS, nowOverride] = process.argv.slice(1);
    const repeat = Number(repeatS);
    const now = nowOverride ? Number(nowOverride) : Math.floor(Date.now() / 1000);

    let apps;
    try {
      const mod = require(path.resolve(ecosystem));
      apps = Array.isArray(mod) ? mod : mod.apps;
    } catch { process.exit(3); }
    let procs;
    try { procs = JSON.parse(fs.readFileSync(jlistFile, "utf8").trim() || "[]"); } catch { process.exit(3); }
    if (!Array.isArray(apps) || !Array.isArray(procs)) process.exit(3);

    let state = {};
    try { state = JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { /* first run / corrupt */ }
    if (!state || typeof state !== "object" || Array.isArray(state)) state = {};

    const next = {};
    for (const app of apps) {
      if (!app || !app.name) continue;
      const proc = procs.find((p) => p && p.name === app.name);
      if (!proc) continue;
      const status = proc.pm2_env && proc.pm2_env.status;
      const parked = status === "errored" || (status === "stopped" && app.autorestart !== false);
      if (!parked) continue;
      const key = app.name + ":" + status;
      const last = Number(state[key]);
      const due = !Number.isFinite(last) || now - last >= repeat;
      next[key] = due ? now : last;
      console.log(app.name + " " + status + " " + (due ? "notify" : "quiet"));
    }
    fs.writeFileSync(statePath, JSON.stringify(next));
  ' "$ECOSYSTEM" "$JLIST_FILE" "$STATE" "$REPEAT" "${STATUS_ALERT_NOW:-}"
)"
status=$?
if [[ "$status" -ne 0 ]]; then
  echo "check-pm2-status: could not load ecosystem file or pm2 output" >&2
  exit 2
fi

if [[ -z "$PROBLEMS" ]]; then
  echo "✅ check-pm2-status ($SCOPE): no declared app is errored or stopped."
  exit 0
fi

MESSAGE="pm2 apps down on $(hostname) ($SCOPE):"
NOTIFY=false
while read -r name app_status mode; do
  [[ -z "$name" ]] && continue
  echo "❌ $name is $app_status in pm2"
  if [[ "$mode" = notify ]]; then
    NOTIFY=true
    MESSAGE="$MESSAGE $name is $app_status;"
  fi
done <<< "$PROBLEMS"

if [[ "$NOTIFY" = true ]]; then
  send_alert_webhook check-pm2-status "$WEBHOOK" "$MESSAGE"
fi
exit 1
