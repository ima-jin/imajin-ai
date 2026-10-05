#!/usr/bin/env bash
#
# check-pm2-restarts.sh — alert when a pm2 app's restart count climbs too fast
# (#2547).
#
# Background: prod-events crash-looped on EADDRINUSE for ~12h (~48k restarts)
# while an orphan kept answering 200, so nothing alerted. A crash loop must not
# be able to hide behind a healthy-looking URL: pm2's per-process restart
# counter is the signal that cannot be masked.
#
# Meant to run every minute or so from cron / a systemd timer. Each run records
# a (timestamp, restart_time) sample per app in a state file and compares the
# current count with the oldest sample still inside the window. An app whose
# count rose by MORE than the threshold within the window is reported, the
# script exits 1, and (when configured) a JSON message is POSTed to a webhook.
#
# Only apps declared in the env's ecosystem file are checked; an unreadable
# ecosystem file is a usage error (exit 2), not a silent pass.
#
# Env:
#   RESTART_ALERT_THRESHOLD  max restarts tolerated in the window (default 5)
#   RESTART_ALERT_WINDOW     window in seconds (default 600)
#   RESTART_ALERT_STATE      state file (default ~/.cache/imajin/pm2-restarts.<scope>.json)
#   RESTART_ALERT_WEBHOOK    optional URL; receives {"text": "..."} on alert
#   RESTART_ALERT_NOW        override "now" (epoch seconds) — tests only
#
# Usage: scripts/check-pm2-restarts.sh [dev|prod] [ecosystem-file]
# Exit:  0 healthy, 1 crash loop detected, 2 usage / environment error.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCOPE="${1:-dev}"
case "$SCOPE" in
  dev|prod) ;;
  *)
    echo "check-pm2-restarts: unknown scope '$SCOPE' (expected dev|prod)" >&2
    exit 2
    ;;
esac
ECOSYSTEM="${2:-$SCRIPT_DIR/../deploy/ecosystem.$SCOPE.config.js}"
THRESHOLD="${RESTART_ALERT_THRESHOLD:-5}"
WINDOW="${RESTART_ALERT_WINDOW:-600}"
STATE="${RESTART_ALERT_STATE:-${HOME:-/tmp}/.cache/imajin/pm2-restarts.$SCOPE.json}"
WEBHOOK="${RESTART_ALERT_WEBHOOK:-}"

if [[ ! -f "$ECOSYSTEM" ]]; then
  echo "check-pm2-restarts: ecosystem file not found: $ECOSYSTEM" >&2
  exit 2
fi
for n in "$THRESHOLD" "$WINDOW"; do
  if ! [[ "$n" =~ ^[0-9]+$ ]]; then
    echo "check-pm2-restarts: threshold/window must be non-negative integers (got '$n')" >&2
    exit 2
  fi
done
mkdir -p "$(dirname "$STATE")" || exit 2

JLIST="$(pm2 jlist 2>/dev/null)" || {
  echo "check-pm2-restarts: 'pm2 jlist' failed" >&2
  exit 2
}

# The node program prints one "<name> <delta> <window-seconds>" line per
# offending app, and rewrites the state file. Exit 3 = could not load inputs.
OFFENDERS="$(
  PM2_JLIST="$JLIST" node -e '
    const fs = require("fs");
    const path = require("path");
    const [ecosystem, statePath, windowS, threshold, nowOverride] = process.argv.slice(1);
    const win = Number(windowS), max = Number(threshold);
    const now = nowOverride ? Number(nowOverride) : Math.floor(Date.now() / 1000);

    let names;
    try {
      const mod = require(path.resolve(ecosystem));
      names = new Set((Array.isArray(mod) ? mod : mod.apps || []).map((a) => a.name));
    } catch { process.exit(3); }
    let procs;
    try { procs = JSON.parse(process.env.PM2_JLIST || "[]"); } catch { process.exit(3); }

    let state = {};
    try { state = JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { /* first run / corrupt */ }

    const next = {};
    for (const p of procs) {
      if (!p || !names.has(p.name)) continue;
      const count = Number(p.pm2_env && p.pm2_env.restart_time);
      if (!Number.isFinite(count)) continue;
      // Keep samples inside the window. A counter that went DOWN (pm2 delete /
      // reset) invalidates history: start over from the current value.
      const samples = (state[p.name] || []).filter(
        (s) => Array.isArray(s) && now - s[0] <= win && s[1] <= count
      );
      samples.push([now, count]);
      next[p.name] = samples;
      const delta = count - samples[0][1];
      if (delta > max) console.log(p.name + " " + delta + " " + (now - samples[0][0]));
    }
    fs.writeFileSync(statePath, JSON.stringify(next));
  ' "$ECOSYSTEM" "$STATE" "$WINDOW" "$THRESHOLD" "${RESTART_ALERT_NOW:-}"
)"
status=$?
if [[ "$status" -ne 0 ]]; then
  echo "check-pm2-restarts: could not load ecosystem file or pm2 output" >&2
  exit 2
fi

if [[ -z "$OFFENDERS" ]]; then
  echo "✅ check-pm2-restarts ($SCOPE): no app exceeded $THRESHOLD restarts in ${WINDOW}s."
  exit 0
fi

MESSAGE="pm2 crash loop on $(hostname) ($SCOPE):"
while read -r name delta secs; do
  [[ -z "$name" ]] && continue
  line="$name restarted $delta times in ${secs}s (threshold $THRESHOLD per ${WINDOW}s)"
  echo "❌ $line"
  MESSAGE="$MESSAGE $line;"
done <<< "$OFFENDERS"

if [[ -n "$WEBHOOK" ]]; then
  payload="$(MSG="$MESSAGE" node -e 'console.log(JSON.stringify({ text: process.env.MSG }))')"
  curl -fsS -m 10 -X POST -H 'Content-Type: application/json' -d "$payload" "$WEBHOOK" >/dev/null \
    || echo "⚠️  check-pm2-restarts: webhook delivery failed" >&2
fi
exit 1
