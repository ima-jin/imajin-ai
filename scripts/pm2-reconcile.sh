#!/usr/bin/env bash
#
# pm2-reconcile.sh — restart pm2 apps from the ecosystem file, recreating any
# whose stored exec path no longer matches it (#2547).
#
# Background: `pm2 restart <app>` and `pm2 startOrRestart <file> --only <app>`
# on an EXISTING process keep the exec path pm2 stored when the app was first
# started and only refresh a few fields (args, env). After #2447 moved the
# ecosystem from `script: npm` / `args: start` to
# `script: node_modules/next/dist/bin/next` / `args: start -p <port>`, a deploy
# therefore ran `npm start -p 3104`: npm swallowed `-p`, `next start` got
# `3104` as its project directory ("Invalid project directory provided") and
# every Next app crash-looped (dev, 2026-10-04). Prod processes are also stored
# as `npm start`, so the same cutover would have hit the next release.
#
# For each <name> given, this compares what the ecosystem file declares
# (script resolved against cwd, plus interpreter when one is declared) with
# pm2's stored pm_exec_path / exec_interpreter (from `pm2 jlist`):
#   - app absent from pm2, or stored exec differs  -> `pm2 delete <name>` (when
#     present) then `pm2 start <file> --only <name>`, so the new definition
#     really takes effect;
#   - otherwise -> kept for a normal `pm2 startOrRestart <file> --only ...`.
# Names the ecosystem file does not declare are reported and skipped (the
# caller restarts those by name).
#
# This script does not `pm2 save`; callers do that once after reconciling.
#
# Usage: scripts/pm2-reconcile.sh <ecosystem-file> <name> [<name> ...]
# Exit:  0 all apps (re)started, 1 at least one failed, 2 usage error.

set -uo pipefail

if [[ $# -lt 2 ]]; then
  echo "usage: pm2-reconcile.sh <ecosystem-file> <name> [<name> ...]" >&2
  exit 2
fi
ECOSYSTEM="$1"
shift
if [[ ! -f "$ECOSYSTEM" ]]; then
  echo "pm2-reconcile: ecosystem file not found: $ECOSYSTEM" >&2
  exit 2
fi

# The `pm2 jlist` output is handed to node through a temp file, never through
# env or argv: on a busy host it outgrows the kernel's per-string exec limit
# (MAX_ARG_STRLEN, 128 KiB) and every exec fails with "Argument list too long"
# (#2603).
JLIST_FILE="$(mktemp "${TMPDIR:-/tmp}/pm2-reconcile-jlist.XXXXXX")" || {
  echo "pm2-reconcile: could not create a temp file" >&2
  exit 1
}
trap 'rm -f "$JLIST_FILE"' EXIT

# Classifies every app in APP_NAMES in one node run, given the ecosystem file
# in $1 and pm2's process list (JSON) in the file $2.
# Prints one `<name> <verdict>` line per app, in APP_NAMES order, where verdict
# is one of:
#   match
#   absent
#   undeclared
#   mismatch <reason>
# Exit 3 = unusable input (nothing is printed in that case).
classify_apps() {
  local ecosystem="$1" jlist_file="$2" status
  node -e '
    const fs = require("fs");
    const path = require("path");
    const [ecosystem, jlistFile, ...names] = process.argv.slice(1);
    let apps;
    try {
      const mod = require(path.resolve(ecosystem));
      apps = Array.isArray(mod) ? mod : mod.apps;
    } catch { process.exit(3); }
    let procs;
    try { procs = JSON.parse(fs.readFileSync(jlistFile, "utf8").trim() || "[]"); } catch { process.exit(3); }
    if (!Array.isArray(apps) || !Array.isArray(procs)) process.exit(3);

    const classify = (name) => {
      const app = apps.find((a) => a && a.name === name);
      if (!app) return "undeclared";
      const proc = procs.find((p) => p && p.name === name);
      if (!proc) return "absent";

      const env = proc.pm2_env || {};
      const stored = env.pm_exec_path || "";
      const script = app.script || "";
      const expected = path.resolve(app.cwd || process.cwd(), script);
      // A bare command (e.g. `npm`) is resolved through PATH by pm2, so the
      // stored path is wherever it was found; match on the command name.
      const bare = script && !script.includes("/");
      const sameExec = stored === expected || (bare && path.basename(stored) === script);
      if (!sameExec) {
        return "mismatch stored exec " + (stored || "<none>") + " != declared " + expected;
      }
      if (app.interpreter) {
        const want = path.basename(String(app.interpreter));
        const have = path.basename(String(env.exec_interpreter || ""));
        if (want !== have) {
          return "mismatch stored interpreter " + (have || "<none>") + " != declared " + want;
        }
      }
      return "match";
    };

    console.log(names.map((name) => name + " " + classify(name)).join("\n"));
  ' "$ecosystem" "$jlist_file" "${APP_NAMES[@]}"
  status=$?
  return "$status"
}

FAILED=0
KEEP=""

APP_NAMES=("$@")

pm2 jlist 2>/dev/null > "$JLIST_FILE"
classify_status=0
verdict_lines="$(classify_apps "$ECOSYSTEM" "$JLIST_FILE")" || classify_status=$?
verdicts=()
if [[ "$classify_status" -eq 0 ]]; then
  mapfile -t verdicts <<< "$verdict_lines"
fi

idx=0
for name in "$@"; do
  line="${verdicts[$idx]:-}"
  idx=$((idx + 1))
  if [[ "$classify_status" -ne 0 ]]; then
    echo "❌ $name: could not compare ecosystem with pm2 state" >&2
    FAILED=$((FAILED + 1))
    continue
  fi
  verdict="${line#"$name "}"
  case "$verdict" in
    match)
      KEEP="${KEEP:+$KEEP,}$name"
      ;;
    undeclared)
      echo "ℹ️  $name is not declared in $ECOSYSTEM — skipping (restart it by name)"
      ;;
    absent|mismatch*)
      if [[ "$verdict" = absent ]]; then
        echo "ℹ️  $name not in pm2 — starting from $ECOSYSTEM"
      else
        echo "⚠️  $name: ${verdict#mismatch } — recreating (pm2 restart would keep the stale definition)"
        if ! pm2 delete "$name"; then
          echo "❌ $name: pm2 delete failed" >&2
          FAILED=$((FAILED + 1))
          continue
        fi
      fi
      if pm2 start "$ECOSYSTEM" --only "$name" --update-env; then
        echo "✅ $name started from $ECOSYSTEM"
      else
        echo "❌ $name: pm2 start failed" >&2
        FAILED=$((FAILED + 1))
      fi
      ;;
    *)
      echo "❌ $name: unexpected classification '$verdict'" >&2
      FAILED=$((FAILED + 1))
      ;;
  esac
done

if [[ -n "$KEEP" ]]; then
  echo "Restarting from $ECOSYSTEM: $KEEP"
  if ! pm2 startOrRestart "$ECOSYSTEM" --only "$KEEP" --update-env; then
    echo "❌ pm2 startOrRestart failed for: $KEEP" >&2
    FAILED=$((FAILED + 1))
  fi
fi

if [[ "$FAILED" -gt 0 ]]; then
  echo "❌ pm2-reconcile: $FAILED step(s) failed."
  exit 1
fi
echo "✅ pm2-reconcile: all requested apps are running from $ECOSYSTEM."
