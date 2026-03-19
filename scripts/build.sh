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
  PM2_PREFIX=""
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
  if ! npx tsx scripts/check-env.ts $ENV_FLAG "$app" 2>&1 | tee -a "$REPORT"; then
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
echo "=== Running migrations ===" | tee -a "$REPORT"
MIGRATION_FAILED=false
for app in "${APPS[@]}"; do
  if [ -f "apps/$app/drizzle.config.ts" ]; then
    echo "--- Migrating $app ---" | tee -a "$REPORT"
    cd "apps/$app"
    set -a; source .env.local 2>/dev/null; set +a
    if npx drizzle-kit migrate >> "$REPORT" 2>&1; then
      echo "✅ $app migrations" | tee -a "$REPORT"
    else
      echo "❌ $app migrations FAILED" | tee -a "$REPORT"
      MIGRATION_FAILED=true
    fi
    cd "$BASE_DIR"
  fi
done
if [ "$MIGRATION_FAILED" = true ]; then
  echo "" | tee -a "$REPORT"
  echo "❌ Migration failures detected. Aborting build." | tee -a "$REPORT"
  exit 1
fi
echo "" >> "$REPORT"

for app in "${APPS[@]}"; do
  echo "=== Building $app ===" | tee -a "$REPORT"
  cd "apps/$app"
  rm -rf .next

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

# Only restart services that built successfully
if [ ${#SUCCEEDED[@]} -gt 0 ]; then
  RESTART_LIST=$(printf "${PM2_PREFIX}%s " "${SUCCEEDED[@]}")
  echo "=== Restarting: $RESTART_LIST ===" | tee -a "$REPORT"
  pm2 restart $RESTART_LIST >> "$REPORT" 2>&1
fi

echo "" >> "$REPORT"
echo "=== [$LABEL] Build finished: $(date) ===" >> "$REPORT"
echo "✅ Succeeded: ${SUCCEEDED[*]:-none}" | tee -a "$REPORT"
echo "❌ Failed: ${FAILED[*]:-none}" | tee -a "$REPORT"

# Exit with error if anything failed
[ ${#FAILED[@]} -eq 0 ]
