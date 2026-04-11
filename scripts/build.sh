#!/bin/bash
# Build and deploy services
# Usage: ./scripts/build.sh [--prod|--dev] [app1 app2 ...]
# Example: ./scripts/build.sh --dev registry www learn
#          ./scripts/build.sh --prod www auth profile
#
# Defaults to dev if not specified.
# Detects environment from the working directory if --prod/--dev not given.

set -e
export PATH=/home/jin/.nvm/versions/node/v22.22.0/bin:$PATH
export NODE_ENV=production

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
if [ "$ENV" = "auto" ]; then
  case "$(pwd)" in
    */prod/*) ENV="prod" ;;
    *)        ENV="dev" ;;
  esac
fi

# Set paths based on environment
if [ "$ENV" = "prod" ]; then
  BASE_DIR="/home/jin/prod/imajin-ai"
  PM2_PREFIX="prod-"
  LABEL="PROD"
else
  BASE_DIR="/home/jin/dev/imajin-ai"
  PM2_PREFIX="dev-"
  LABEL="DEV"
fi

REPORT="$BASE_DIR/.build-report"

# Default to www if no apps specified
if [ ${#APPS[@]} -eq 0 ]; then
  APPS=("www")
fi

FAILED=()
SUCCEEDED=()

echo "=== [$LABEL] Build started: $(date) ===" > "$REPORT"
echo "Apps: ${APPS[*]}" >> "$REPORT"
echo "" >> "$REPORT"

cd "$BASE_DIR"

# Pre-flight: check env vars for all target apps
echo "=== Pre-flight: checking env vars ===" | tee -a "$REPORT"
ENV_FLAG="--env dev"
[ "$ENV" = "prod" ] && ENV_FLAG="--env prod"

ENV_CHECK_FAILED=false
for app in "${APPS[@]}"; do
  set -o pipefail
  if ! npx --yes tsx scripts/check-env.ts $ENV_FLAG "$app" 2>&1 | tee -a "$REPORT"; then
    ENV_CHECK_FAILED=true
  fi
  set +o pipefail
done

if [ "$ENV_CHECK_FAILED" = true ]; then
  echo "" | tee -a "$REPORT"
  echo "❌ Env check found errors. Fix missing vars before building." | tee -a "$REPORT"
  echo "   Run: npx tsx scripts/check-env.ts $ENV_FLAG ${APPS[*]}" | tee -a "$REPORT"
  exit 1
fi
echo "" >> "$REPORT"

# Run pending migrations before building — stop if any fail
# Uses migrate-service.mjs for per-service tracking tables (__drizzle_migrations_<app>)
# to avoid conflicts from shared __drizzle_migrations table across 14+ services.
echo "=== Running migrations ===" | tee -a "$REPORT"
MIGRATION_FAILED=false
for app in "${APPS[@]}"; do
  if [ -f "apps/$app/drizzle.config.ts" ]; then
    echo "--- Migrating $app ---" | tee -a "$REPORT"
    if node scripts/migrate-service.mjs "$app" >> "$REPORT" 2>&1; then
      echo "✅ $app migrations" | tee -a "$REPORT"
    else
      echo "❌ $app migrations FAILED" | tee -a "$REPORT"
      MIGRATION_FAILED=true
    fi
  fi
done
if [ "$MIGRATION_FAILED" = true ]; then
  echo "" | tee -a "$REPORT"
  echo "❌ Migration failures detected. Aborting build." | tee -a "$REPORT"
  exit 1
fi
echo "" >> "$REPORT"

# Set build metadata for BuildInfo component
export NEXT_PUBLIC_VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "dev")
export NEXT_PUBLIC_BUILD_HASH=$(git rev-parse --short HEAD 2>/dev/null || echo "local")
export NEXT_PUBLIC_COMMIT_COUNT=$(git rev-list --count HEAD 2>/dev/null || echo "")
echo "Build: imajin $NEXT_PUBLIC_VERSION+$NEXT_PUBLIC_COMMIT_COUNT · $NEXT_PUBLIC_BUILD_HASH" | tee -a "$REPORT"
echo "" >> "$REPORT"

for app in "${APPS[@]}"; do
  echo "=== Building $app ===" | tee -a "$REPORT"
  cd "apps/$app"
  rm -rf .next || true

  if npx next build >> "$REPORT" 2>&1; then
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

# Only restart services that built successfully
if [ ${#SUCCEEDED[@]} -gt 0 ]; then
  RESTART_LIST=""
  for app in "${SUCCEEDED[@]}"; do
    RESTART_LIST+="$(pm2_name "$app") "
  done
  echo "=== Restarting: $RESTART_LIST ===" | tee -a "$REPORT"
  pm2 restart $RESTART_LIST >> "$REPORT" 2>&1
fi

echo "" >> "$REPORT"
echo "=== [$LABEL] Build finished: $(date) ===" >> "$REPORT"
echo "✅ Succeeded: ${SUCCEEDED[*]:-none}" | tee -a "$REPORT"
echo "❌ Failed: ${FAILED[*]:-none}" | tee -a "$REPORT"

# Exit with error if anything failed
[ ${#FAILED[@]} -eq 0 ]
