#!/bin/bash
# Build and deploy services
# Usage: ./scripts/build.sh [--prod|--dev] [app1 app2 ...]
# Example: ./scripts/build.sh --dev registry www learn
#          ./scripts/build.sh --prod www auth profile
#
# Defaults to dev if not specified.
# Detects environment from the working directory if --prod/--dev not given.

set -e
export NODE_ENV=production

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Parse environment flag
ENV="auto"
APPS=()
for arg in "$@"; do
  case "$arg" in
    --prod) ENV="prod" ;;
    --dev)  ENV="dev" ;;
    *)      APPS+=("$arg") ;;
  esac
done

# Auto-detect from cwd if not specified
if [[ "$ENV" = "auto" ]]; then
  case "$(pwd)" in
    */prod/*) ENV="prod" ;;
    *)        ENV="dev" ;;
  esac
fi

# Set paths based on environment
BASE_DIR="$REPO_ROOT"
if [[ "$ENV" = "prod" ]]; then
  PM2_PREFIX="prod-"
  LABEL="PROD"
else
  PM2_PREFIX="dev-"
  LABEL="DEV"
fi

REPORT="$BASE_DIR/.build-report"

# Default to www if no apps specified
if [[ ${#APPS[@]} -eq 0 ]]; then
  APPS=("www")
fi

FAILED=()
SUCCEEDED=()
PORT_REAP_FAILED=false
PORT_REAP_FAILURES=()

echo "=== [$LABEL] Build started: $(date) ===" > "$REPORT"
echo "Apps: ${APPS[*]}" >> "$REPORT"
echo "" >> "$REPORT"

cd "$BASE_DIR"

# Pre-flight: check env vars for all target apps
echo "=== Pre-flight: checking env vars ===" | tee -a "$REPORT"
ENV_FLAG="--env dev"
[[ "$ENV" = "prod" ]] && ENV_FLAG="--env prod"

ENV_CHECK_FAILED=false
for app in "${APPS[@]}"; do
  set -o pipefail
  # `pnpm exec tsx` (not `npx --yes tsx`): resolves the tsx devDependency
  # already pinned in the root package.json instead of letting npx install an
  # on-demand, unpinned copy of the CLI.
  if ! pnpm exec tsx scripts/check-env.ts $ENV_FLAG "$app" 2>&1 | tee -a "$REPORT"; then
    ENV_CHECK_FAILED=true
  fi
  set +o pipefail
done

if [[ "$ENV_CHECK_FAILED" = true ]]; then
  echo "" | tee -a "$REPORT"
  echo "❌ Env check found errors. Fix missing vars before building." | tee -a "$REPORT"
  echo "   Run: pnpm exec tsx scripts/check-env.ts $ENV_FLAG ${APPS[*]}" | tee -a "$REPORT"
  exit 1
fi
echo "" >> "$REPORT"

echo "=== Building workspace packages ==="  | tee -a "$REPORT"
if pnpm -r --filter './packages/**' build >> "$REPORT" 2>&1; then
  echo "✅ Packages built" | tee -a "$REPORT"
else
  echo "⚠️  Package build had errors (non-fatal, some packages may lack build scripts)" | tee -a "$REPORT"
fi
echo "" >> "$REPORT"

echo "=== Running migrations ===" | tee -a "$REPORT"
if node scripts/migrate.mjs >> "$REPORT" 2>&1; then
  echo "✅ Migrations complete" | tee -a "$REPORT"
else
  echo "❌ Migrations FAILED" | tee -a "$REPORT"
  exit 1
fi
echo "" >> "$REPORT"

# Set build metadata for BuildInfo component.
#
# Tag is truth (#2285): the nearest reachable vX.Y.Z tag is what actually
# shipped to prod (see .github/workflows/tag-release.yml), so it takes
# priority over package.json's `version` field — which is bumped in lockstep
# by the Release workflow but can otherwise drift from what's actually
# deployed (see packages/ui/src/BuildInfo.tsx). Falls back to package.json's
# version on an untagged checkout, then "dev" if that's also unavailable
# (e.g. no package.json, or it fails to parse).
#
# shellcheck source=scripts/lib/build-version.sh
source "$REPO_ROOT/scripts/lib/build-version.sh"
GIT_TAG_VERSION="$(compute_git_tag_version)"
if [[ -n "$GIT_TAG_VERSION" ]]; then
  export NEXT_PUBLIC_VERSION="$GIT_TAG_VERSION"
else
  export NEXT_PUBLIC_VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "dev")
fi
export NEXT_PUBLIC_BUILD_HASH=$(git rev-parse --short HEAD 2>/dev/null || echo "local")
export NEXT_PUBLIC_COMMIT_COUNT=$(git rev-list --count HEAD 2>/dev/null || echo "")
echo "Build: imajin $NEXT_PUBLIC_VERSION+$NEXT_PUBLIC_COMMIT_COUNT · $NEXT_PUBLIC_BUILD_HASH" | tee -a "$REPORT"
echo "" >> "$REPORT"

for app in "${APPS[@]}"; do
  echo "=== Building $app ===" | tee -a "$REPORT"
  cd "apps/$app"

  # Non-Next.js apps (e.g. broker-agent) don't need next build — mark as succeeded
  # and let pm2 restart handle the runtime reload.
  if [[ ! -f "next.config.js" && ! -f "next.config.ts" && ! -f "next.config.mjs" ]]; then
    SUCCEEDED+=("$app")
    echo "✅ $app (no next build — daemon process)" | tee -a "$REPORT"
    cd "$BASE_DIR"
    echo "" >> "$REPORT"
    continue
  fi

  rm -rf .next || true

  # `pnpm run build` (not `npx next build`): every Next.js app here declares
  # its own pinned `next` dependency and a `build` script that runs `next
  # build`, so this resolves the locally installed binary instead of letting
  # npx install an on-demand, unpinned copy of Next.js.
  if pnpm run build >> "$REPORT" 2>&1; then
    SUCCEEDED+=("$app")
    echo "✅ $app" | tee -a "$REPORT"
  else
    FAILED+=("$app")
    echo "❌ $app — FAILED" | tee -a "$REPORT"
  fi

  cd "$BASE_DIR"
  echo "" >> "$REPORT"
done

# Map app names to pm2 process names
# kernel → jin (the node), everything else → same name
pm2_name() {
  local app="$1"
  case "$app" in
    kernel) echo "${PM2_PREFIX}jin" ;;
    *)      echo "${PM2_PREFIX}${app}" ;;
  esac
}

# Ecosystem config lives one level above the repo root, named per environment
# (~/dev/ecosystem.config.js or ~/prod/ecosystem.config.js). Used to cold-start
# services pm2 has never seen yet (e.g. a newly added app).
ECOSYSTEM_FILE="$(dirname "$BASE_DIR")/ecosystem.config.js"

# --- Orphan-port reaping (#2094) --------------------------------------------
#
# An orphaned `node server.js` from a prior deploy can survive `pm2 delete`
# (reparented to init) and keep holding an app's port. When that happens, the
# `pm2 restart` below starts a fresh process that immediately fails to bind
# and crash-loops. Before restarting each app we:
#   1. look up its port from the canonical service manifest
#      (packages/config/src/services.ts — the same source scripts/check-env.ts
#      already uses), so this script doesn't grow a second, divergent port
#      table;
#   2. check for a listener on that port pm2 doesn't own (same "not in
#      `pm2 jlist`" rule scripts/reap-orphans.sh already uses) and kill it;
#   3. re-check with a short bounded wait for the port to free up;
#   4. if it's still held, fail loudly (naming the pid/cmd) and skip the
#      restart for that app instead of handing pm2 a doomed process.

# Print $app's port for the current $ENV, looked up from the canonical
# manifest. Prints nothing (and never aborts the build) if the lookup can't
# be made — the restart proceeds without the extra safety check in that case.
service_port_for_app() {
  local app="$1"
  local script=""
  script="$(mktemp "${TMPDIR:-/tmp}/build-sh-port.XXXXXX.mts" 2>/dev/null || true)"
  if [[ -z "$script" ]]; then
    return 0
  fi
  cat > "$script" <<EOF
import { getPort } from "file://${BASE_DIR}/packages/config/src/services.ts";
const env = process.env.BUILD_SH_PORT_ENV === "prod" ? "prod" : "dev";
const port = getPort(process.env.BUILD_SH_PORT_APP || "", env);
process.stdout.write(port ? String(port) : "");
EOF
  local port=""
  port="$(BUILD_SH_PORT_APP="$app" BUILD_SH_PORT_ENV="$ENV" pnpm exec tsx "$script" 2>/dev/null || true)"
  rm -f "$script"
  printf '%s' "$port"
}

# is_pm2_owned/pm2_managed_pids/pm2_has_name/pm2_app_is_online/ecosystem_has_app
# come from the shared helper (also used by scripts/reap-orphans.sh) so the
# two never drift again (#2237). is_pm2_owned walks the ancestor chain — not
# just an exact pid match — since pm2 fork-mode tracks the wrapper process
# (e.g. `next start`) while the port is actually held by a grandchild (e.g.
# `next-server`, or tsx→node for corpus).
# shellcheck source=scripts/lib/pm2-owned.sh
source "$REPO_ROOT/scripts/lib/pm2-owned.sh"

# Services declared in the manifest but not hosted on this box (e.g. corpus
# runs on gx10) — skip them outright instead of burning a cold-start attempt
# and warning on every deploy (#2344).
# shellcheck source=scripts/lib/deploy-skip.sh
source "$REPO_ROOT/scripts/lib/deploy-skip.sh"

# Reap any listener on $port that pm2 doesn't own, then verify (short bounded
# wait) that the port is actually free. Returns 1 only when the port is truly
# stuck AND pm2 doesn't report the app online; returns 0 (with a warning, not
# an error) when the remaining listener turns out to be pm2-owned or pm2
# otherwise reports the app healthy — see the exit-status note below (#2344).
# Expects the global PM2_PIDS to already be populated via pm2_managed_pids.
reap_orphan_port() {
  local app="$1" port="$2"
  local pid cmd listeners stray name
  name="$(pm2_name "$app")"

  if ! command -v ss >/dev/null 2>&1; then
    echo "ℹ️  ss not found — skipping orphan-port check for $app (:$port)" | tee -a "$REPORT"
    return 0
  fi

  # Refresh before every use, not just once for the whole restart batch: pm2
  # can respawn an app (with a brand-new pid) between when PM2_PIDS was last
  # captured and now — e.g. right after this same function killed a pid one
  # app ago, or in the retry loop below right after killing this app's own
  # stray. A stale snapshot is exactly what produced #2344's false failure.
  PM2_PIDS="$(pm2_managed_pids)"

  listeners="$(ss -ltnpH "sport = :$port" 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u || true)"
  for pid in $listeners; do
    [[ -z "$pid" ]] && continue
    is_pm2_owned "$pid" && continue
    cmd="$(ps -o cmd= -p "$pid" 2>/dev/null || echo '?')"
    echo "⚠️  Orphan on :$port ($app) — pid $pid ($cmd) not owned by pm2. Reaping." | tee -a "$REPORT"
    kill "$pid" 2>/dev/null || true
    sleep 2
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null || true
    fi
  done

  for _ in 1 2 3 4 5; do
    stray=""
    PM2_PIDS="$(pm2_managed_pids)"
    listeners="$(ss -ltnpH "sport = :$port" 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u || true)"
    for pid in $listeners; do
      [[ -z "$pid" ]] && continue
      is_pm2_owned "$pid" || stray="$pid"
    done
    [[ -z "$stray" ]] && return 0
    sleep 0.5
  done

  cmd="$(ps -o cmd= -p "$stray" 2>/dev/null || echo '?')"
  # A pid we still can't attribute to pm2 is, by itself, an ownership/
  # reporting mismatch, not proof the service is down (#2344) — pm2's own
  # "online" status is the actual health signal. Only fail the build when
  # pm2 agrees something is wrong.
  if pm2_app_is_online "$name"; then
    echo "⚠️  Port $port ($app) still shows pid $stray ($cmd) after reaping, but pm2 reports $name online — treating as pm2-managed, not a failure." | tee -a "$REPORT"
    return 0
  fi

  echo "❌ Port $port ($app) still held by pid $stray ($cmd) after reaping, and pm2 does not report $name online — refusing to restart $app." | tee -a "$REPORT"
  return 1
}

# Restart services that built successfully.
# Restart each one individually so a single missing/unknown process can't abort
# the whole batch. If pm2 has never seen the process (new service), fall back to
# starting it from the ecosystem config.
if [[ ${#SUCCEEDED[@]} -gt 0 ]]; then
  RESTART_LIST=""
  for app in "${SUCCEEDED[@]}"; do
    RESTART_LIST+="$(pm2_name "$app") "
  done
  echo "=== Restarting: $RESTART_LIST ===" | tee -a "$REPORT"

  RESTART_FAILED=()
  for app in "${SUCCEEDED[@]}"; do
    name="$(pm2_name "$app")"

    if is_skipped_service "$app"; then
      echo "ℹ️  Skipping $name (not hosted here)" | tee -a "$REPORT"
      continue
    fi

    port="$(service_port_for_app "$app")"

    # Daemon processes with no HTTP port (devPort/prodPort 0 or unset in the
    # manifest, e.g. broker-agent — #1101) that pm2 doesn't already manage and
    # that have no entry in this env's ecosystem config aren't ours to
    # restart: they're either not deployed here, or run on another host.
    # Skip them instead of letting `pm2 restart` fail and the cold-start
    # fallback fail too, which produced a misleading ⚠️ on every build.
    if [[ -z "$port" || "$port" = "0" ]] \
       && ! pm2_has_name "$name" \
       && ! ecosystem_has_app "$name" "$ECOSYSTEM_FILE"; then
      echo "ℹ️  Skipping $name — no port configured and not managed by pm2 or $ECOSYSTEM_FILE here" | tee -a "$REPORT"
      continue
    fi

    if [[ -n "$port" && "$port" != "0" ]] && ! reap_orphan_port "$app" "$port"; then
      RESTART_FAILED+=("$name")
      PORT_REAP_FAILED=true
      PORT_REAP_FAILURES+=("${app}(${port})")
      continue
    fi
    if pm2 restart "$name" --update-env >> "$REPORT" 2>&1; then
      continue
    fi
    # pm2 doesn't know this process yet — try to cold-start from ecosystem config.
    echo "ℹ️  $name not running — attempting cold start from ecosystem config" | tee -a "$REPORT"
    # `pm2 start <file> --only <name>` exits 0 even when <name> matches nothing
    # in the file, so verify the process actually exists afterwards.
    if [[ -f "$ECOSYSTEM_FILE" ]] && pm2 start "$ECOSYSTEM_FILE" --only "$name" >> "$REPORT" 2>&1 \
       && pm2_has_name "$name"; then
      echo "✅ $name started from ecosystem config" | tee -a "$REPORT"
    else
      echo "⚠️  Could not restart or start $name (not in pm2 and not in $ECOSYSTEM_FILE)" | tee -a "$REPORT"
      RESTART_FAILED+=("$name")
    fi
  done

  if [[ ${#RESTART_FAILED[@]} -gt 0 ]]; then
    echo "⚠️  Services that could not be (re)started: ${RESTART_FAILED[*]}" | tee -a "$REPORT"
  fi
  pm2 save >> "$REPORT" 2>&1 || true
fi

echo "" >> "$REPORT"
echo "=== [$LABEL] Build finished: $(date) ===" >> "$REPORT"
echo "✅ Succeeded: ${SUCCEEDED[*]:-none}" | tee -a "$REPORT"
echo "❌ Failed: ${FAILED[*]:-none}" | tee -a "$REPORT"
if [[ "$PORT_REAP_FAILED" = true ]]; then
  echo "❌ Port-reap failures: ${PORT_REAP_FAILURES[*]}" | tee -a "$REPORT"
fi

# Exit with error if anything failed, including apps skipped because an
# orphaned process couldn't be cleared off their port (#2094).
[[ ${#FAILED[@]} -eq 0 && "$PORT_REAP_FAILED" = false ]]
