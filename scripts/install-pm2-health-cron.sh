#!/usr/bin/env bash
#
# install-pm2-health-cron.sh — schedule scripts/pm2-health-check.sh on this
# host, idempotently (#2572).
#
# The deploy workflows run this after every deploy, so the dev and prod hosts
# start (and keep) checking pm2 every minute with no manual crontab edit — the
# crash-loop alert from #2547 used to be "host configuration, not installed by
# the deploy workflow", which is how an app parked `errored` went unheard.
#
# What it does:
#   1. install check — pm2/node on PATH, ecosystem file present, `crontab`
#      available; otherwise fails (exit 2) before touching anything;
#   2. when PM2_ALERT_WEBHOOK is set, stores it in the 0600 file
#      ~/.config/imajin/pm2-alert-webhook.<scope> (override: PM2_ALERT_WEBHOOK_FILE)
#      that pm2-health-check.sh reads. Unset keeps whatever file is there; with
#      none, alerts only reach the log and a warning says so;
#   3. replaces this scope's crontab line (tagged `# imajin-pm2-health:<scope>`)
#      with one that runs the health check every minute from this checkout.
#      Other crontab lines are left alone; dev and prod entries are independent.
#
# The cron command carries the PATH it was installed with (cron's own PATH has
# no nvm node or pm2) and appends only problems to
# ~/.cache/imajin/pm2-health.<scope>.log (PM2_HEALTH_QUIET=1).
#
# Usage: scripts/install-pm2-health-cron.sh <dev|prod> [ecosystem-file]
# Exit:  0 installed, 2 usage / environment error.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/pm2-preflight.sh
source "$SCRIPT_DIR/lib/pm2-preflight.sh"

SCOPE="${1:-}"
case "$SCOPE" in
  dev|prod) ;;
  *)
    echo "usage: install-pm2-health-cron.sh <dev|prod> [ecosystem-file]" >&2
    exit 2
    ;;
esac
ECOSYSTEM="${2:-$SCRIPT_DIR/../deploy/ecosystem.$SCOPE.config.js}"
MARKER="# imajin-pm2-health:$SCOPE"
LOG_FILE="${HOME:-/tmp}/.cache/imajin/pm2-health.$SCOPE.log"
WEBHOOK_FILE="${PM2_ALERT_WEBHOOK_FILE:-${HOME:-/tmp}/.config/imajin/pm2-alert-webhook.$SCOPE}"

pm2_preflight install-pm2-health-cron "$ECOSYSTEM" || exit 2
if ! command -v crontab >/dev/null 2>&1; then
  echo "install-pm2-health-cron: 'crontab' is not installed on $(hostname) — cannot schedule the pm2 health check" >&2
  exit 2
fi
if [[ "$PATH" == *$'\n'* ]]; then
  echo "install-pm2-health-cron: PATH contains a newline — refusing to write it into a crontab" >&2
  exit 2
fi

mkdir -p "$(dirname "$LOG_FILE")" || exit 2

if [[ -n "${PM2_ALERT_WEBHOOK:-}" ]]; then
  mkdir -p "$(dirname "$WEBHOOK_FILE")" || exit 2
  (umask 077 && printf '%s\n' "$PM2_ALERT_WEBHOOK" > "$WEBHOOK_FILE") || {
    echo "install-pm2-health-cron: could not write $WEBHOOK_FILE" >&2
    exit 2
  }
  echo "✅ Stored the alert webhook in $WEBHOOK_FILE"
elif [[ ! -s "$WEBHOOK_FILE" ]]; then
  echo "⚠️  No alert webhook configured (set the PM2_ALERT_WEBHOOK secret): the health check will only log to $LOG_FILE" >&2
fi

# Every value is shell-quoted (%q) so spaces and other metacharacters survive
# cron's `sh -c`; crontab itself treats an unescaped % as a newline, so those
# are backslash-escaped across the whole line.
ENTRY="* * * * * PATH=$(printf '%q' "$PATH") PM2_HEALTH_QUIET=1 PM2_ALERT_WEBHOOK_FILE=$(printf '%q' "$WEBHOOK_FILE") $(printf '%q' "$SCRIPT_DIR/pm2-health-check.sh") $SCOPE $(printf '%q' "$ECOSYSTEM") >> $(printf '%q' "$LOG_FILE") 2>&1 $MARKER"
PERCENT='%'
ESCAPED_PERCENT='\%'
ENTRY="${ENTRY//$PERCENT/$ESCAPED_PERCENT}"

# `crontab -l` exits non-zero when the user has no crontab yet; that is an
# empty list, not an error.
CURRENT="$(crontab -l 2>/dev/null || true)"
NEXT="$(printf '%s\n' "$CURRENT" | grep -vF -- "$MARKER" || true)"
if [[ -n "$NEXT" ]]; then
  NEXT="$NEXT"$'\n'"$ENTRY"
else
  NEXT="$ENTRY"
fi
if ! printf '%s\n' "$NEXT" | crontab -; then
  echo "install-pm2-health-cron: 'crontab -' failed" >&2
  exit 2
fi

echo "✅ pm2 health check ($SCOPE) scheduled every minute: $ENTRY"
