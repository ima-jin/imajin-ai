#!/usr/bin/env bash
#
# pm2-health-check.sh — the one entry point for the scheduled post-deploy pm2
# health check (#2572).
#
# Runs, in order:
#   1. the install check (pm2 + node on PATH, ecosystem file present),
#   2. scripts/check-pm2-restarts.sh — crash loops (restart counter climbing),
#   3. scripts/check-pm2-status.sh   — apps parked errored/stopped,
# and exits with the worst result, so a crash loop OR a parked app is heard
# either way. Both checks POST to the same alert webhook.
#
# It is what scripts/install-pm2-health-cron.sh schedules every minute on the
# dev and prod hosts (installed by the deploy workflows, no manual steps), and
# what the deploy workflows run once right after a deploy.
#
# The webhook URL is read from, in order: RESTART_ALERT_WEBHOOK /
# STATUS_ALERT_WEBHOOK in the environment, then the 0600 file
# $PM2_ALERT_WEBHOOK_FILE (default ~/.config/imajin/pm2-alert-webhook.<scope>)
# which the installer writes — cron's environment is empty, so a file is the
# only place it can live without being baked into the crontab.
#
# Env:
#   PM2_HEALTH_QUIET=1        print nothing when everything is healthy (cron
#                             sets this so the log only holds problems)
#   PM2_ALERT_WEBHOOK_FILE    file holding the webhook URL (see above)
#   (plus the RESTART_ALERT_* / STATUS_ALERT_* tunables of the two checks)
#
# Usage: scripts/pm2-health-check.sh [dev|prod] [ecosystem-file]
# Exit:  0 healthy, 1 crash loop or errored/stopped app, 2 usage / environment
#        error (bad scope, pm2/node missing, ecosystem file missing).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/pm2-preflight.sh
source "$SCRIPT_DIR/lib/pm2-preflight.sh"

SCOPE="${1:-dev}"
case "$SCOPE" in
  dev|prod) ;;
  *)
    echo "pm2-health-check: unknown scope '$SCOPE' (expected dev|prod)" >&2
    exit 2
    ;;
esac
ECOSYSTEM="${2:-$SCRIPT_DIR/../deploy/ecosystem.$SCOPE.config.js}"

pm2_preflight pm2-health-check "$ECOSYSTEM" || exit 2

WEBHOOK_FILE="${PM2_ALERT_WEBHOOK_FILE:-${HOME:-/tmp}/.config/imajin/pm2-alert-webhook.$SCOPE}"
if [[ -z "${RESTART_ALERT_WEBHOOK:-}" && -z "${STATUS_ALERT_WEBHOOK:-}" && -r "$WEBHOOK_FILE" ]]; then
  FILE_URL="$(tr -d '[:space:]' < "$WEBHOOK_FILE")"
  if [[ -n "$FILE_URL" ]]; then
    export RESTART_ALERT_WEBHOOK="$FILE_URL"
  fi
fi

worst=0
output=""
for check in check-pm2-restarts check-pm2-status; do
  check_status=0
  check_out="$(bash "$SCRIPT_DIR/$check.sh" "$SCOPE" "$ECOSYSTEM" 2>&1)" || check_status=$?
  output="${output:+$output$'\n'}$check_out"
  if [[ "$check_status" -gt "$worst" ]]; then
    worst="$check_status"
  fi
done

if [[ "$worst" -ne 0 || "${PM2_HEALTH_QUIET:-}" != "1" ]]; then
  echo "[$(date -u +%FT%TZ)] pm2-health-check ($SCOPE)"
  echo "$output"
fi
exit "$worst"
