#!/usr/bin/env bash
# alert-webhook.sh — POST an alert message to a webhook as {"text": "..."}.
#
# Shared by scripts/check-pm2-restarts.sh and scripts/check-pm2-status.sh so
# both alert the same way (same payload shape: Slack/Discord-compatible `text`).
#
# Usage (source, don't execute):
#   send_alert_webhook <tool-name> <webhook-url> <message>
# A missing URL is a silent no-op (the caller already printed the alert on
# stdout/the log); a failed delivery only warns, it never changes the caller's
# exit status.

send_alert_webhook() {
  local tool="$1" url="$2" message="$3" payload
  [[ -z "$url" ]] && return 0
  payload="$(MSG="$message" node -e 'console.log(JSON.stringify({ text: process.env.MSG }))')"
  curl -fsS -m 10 -X POST -H 'Content-Type: application/json' -d "$payload" "$url" >/dev/null \
    || echo "⚠️  $tool: webhook delivery failed" >&2
  return 0
}
