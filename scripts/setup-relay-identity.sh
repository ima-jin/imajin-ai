#!/bin/bash
# Generate persistent relay identity using the DFOS Go CLI.
# Run once per environment. Appends RELAY_DID and RELAY_PROFILE_JWS to registry .env.local.
#
# Prerequisites: dfos CLI installed (go install github.com/metalabel/dfos/cmd/dfos@latest)
#
# Usage: ./scripts/setup-relay-identity.sh [--prod|--dev]

set -e

ENV="dev"
case "$1" in
  --prod) ENV="prod" ;;
  --dev)  ENV="dev" ;;
esac

if [ "$ENV" = "prod" ]; then
  ENV_FILE="/home/jin/prod/imajin-ai/apps/registry/.env.local"
else
  ENV_FILE="/home/jin/dev/imajin-ai/apps/registry/.env.local"
fi

# Check if already configured
if grep -q "RELAY_DID=" "$ENV_FILE" 2>/dev/null; then
  echo "⚠️  RELAY_DID already set in $ENV_FILE"
  echo "   Remove the existing RELAY_DID and RELAY_PROFILE_JWS lines to regenerate."
  exit 1
fi

# Check for dfos CLI
if ! command -v dfos &>/dev/null; then
  echo "❌ dfos CLI not found."
  echo "   Install: go install github.com/metalabel/dfos/cmd/dfos@latest"
  echo "   (or check Brandon's repo for the latest install path)"
  exit 1
fi

echo "=== Generating relay identity for $ENV ==="

# Generate identity offline
OUTPUT=$(dfos identity create --name "Imajin Registry Relay")

# Extract DID and profile JWS from output
# TODO: adjust parsing based on actual dfos CLI output format
RELAY_DID=$(echo "$OUTPUT" | grep -oP 'did:dfos:\S+')
RELAY_PROFILE_JWS=$(echo "$OUTPUT" | grep -oP 'eyJ\S+')

if [ -z "$RELAY_DID" ] || [ -z "$RELAY_PROFILE_JWS" ]; then
  echo "❌ Failed to parse identity from dfos output:"
  echo "$OUTPUT"
  echo ""
  echo "Manually add these to $ENV_FILE:"
  echo "  RELAY_DID=<did from output>"
  echo "  RELAY_PROFILE_JWS=<profile JWS from output>"
  exit 1
fi

echo "" >> "$ENV_FILE"
echo "# DFOS Relay Identity (generated $(date -Iseconds))" >> "$ENV_FILE"
echo "RELAY_DID=$RELAY_DID" >> "$ENV_FILE"
echo "RELAY_PROFILE_JWS=$RELAY_PROFILE_JWS" >> "$ENV_FILE"

echo ""
echo "✅ Relay identity written to $ENV_FILE"
echo "   DID: $RELAY_DID"
echo ""
echo "Restart registry to pick it up:"
if [ "$ENV" = "prod" ]; then
  echo "   pm2 restart prod-registry"
else
  echo "   pm2 restart registry"
fi
