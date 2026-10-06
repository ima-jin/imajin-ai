#!/usr/bin/env bash
# pm2-preflight.sh — verify the host can run pm2 tooling at all (#2572).
#
# pm2-reconcile.sh and the post-deploy health check both assume `pm2` and
# `node` are on PATH and that the ecosystem config exists. When one isn't (a
# fresh or rebuilt host, a runner whose PATH lost the nvm node), the failure
# used to surface as a confusing mid-script error — or worse, as an empty
# `pm2 jlist` that looked like "nothing to do". This turns it into one clear
# message and a distinct exit code before anything is touched.
#
# Usage (source, don't execute):
#   pm2_preflight <tool-name> <ecosystem-file> || exit $?
# Returns 0 when ready, 2 (environment error) otherwise, after printing which
# requirement is missing to stderr.

pm2_preflight() {
  local tool="$1" ecosystem="$2" missing=0 cmd
  for cmd in pm2 node; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      echo "$tool: '$cmd' is not installed or not on PATH on $(hostname)" >&2
      missing=1
    fi
  done
  if [[ ! -f "$ecosystem" ]]; then
    echo "$tool: ecosystem file not found: $ecosystem" >&2
    missing=1
  fi
  if [[ "$missing" -ne 0 ]]; then
    return 2
  fi
  return 0
}
