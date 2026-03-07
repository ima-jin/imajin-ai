#!/bin/bash
# Build and deploy dev services
# Usage: ./scripts/build-dev.sh [app1 app2 ...]
# Example: ./scripts/build-dev.sh registry www learn

set -e
export PATH=/home/jin/.nvm/versions/node/v22.22.0/bin:$PATH

REPORT="/home/jin/dev/imajin-ai/.build-report"
APPS="${@:-www}"
FAILED=()
SUCCEEDED=()

echo "=== Build started: $(date) ===" > "$REPORT"
echo "Apps: $APPS" >> "$REPORT"
echo "" >> "$REPORT"

cd /home/jin/dev/imajin-ai

for app in $APPS; do
  echo "=== Building $app ===" | tee -a "$REPORT"
  cd "apps/$app"
  rm -rf .next

  if npx next build >> "$REPORT" 2>&1; then
    SUCCEEDED+=("$app")
    echo "✅ $app" | tee -a "$REPORT"
  else
    FAILED+=("$app")
    echo "❌ $app — FAILED" | tee -a "$REPORT"
    # Don't restart failed builds
  fi

  cd ../..
  echo "" >> "$REPORT"
done

# Only restart services that built successfully
if [ ${#SUCCEEDED[@]} -gt 0 ]; then
  RESTART_LIST=$(printf "dev-%s " "${SUCCEEDED[@]}")
  echo "=== Restarting: $RESTART_LIST ===" | tee -a "$REPORT"
  pm2 restart $RESTART_LIST >> "$REPORT" 2>&1
fi

echo "" >> "$REPORT"
echo "=== Build finished: $(date) ===" >> "$REPORT"
echo "✅ Succeeded: ${SUCCEEDED[*]:-none}" | tee -a "$REPORT"
echo "❌ Failed: ${FAILED[*]:-none}" | tee -a "$REPORT"

# Exit with error if anything failed
[ ${#FAILED[@]} -eq 0 ]
