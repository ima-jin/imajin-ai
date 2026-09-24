#!/usr/bin/env bash
# deploy-skip.sh — services intentionally not hosted on this box (#2344).
#
# The canonical service manifest (packages/config/src/services.ts) declares a
# real, nonzero prod port for every service, including ones that don't run on
# this host — e.g. corpus runs on gx10, not the box deploy-prod.yml targets.
# Without an explicit skip list, build.sh's restart loop treats a nonzero
# port as "should be running here", finds nothing on it, burns a cold-start
# attempt against the local ecosystem config, and logs a misleading
# "not in pm2 and not in ecosystem.config.js" warning on every single deploy
# for a service that was never supposed to be here.
#
# Usage (source, don't execute):
#   source "$(dirname "$0")/lib/deploy-skip.sh"
#   is_skipped_service "corpus" && echo "not hosted here"

# Space-separated app names not hosted on this box. Override via env for a
# one-off deploy (or once another service moves off-box) without editing
# this file.
DEPLOY_SKIP_SERVICES="${DEPLOY_SKIP_SERVICES:-corpus}"

is_skipped_service() {
  local app="$1" skip
  for skip in $DEPLOY_SKIP_SERVICES; do
    [[ "$skip" = "$app" ]] && return 0
  done
  return 1
}
