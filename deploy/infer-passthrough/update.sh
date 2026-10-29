#!/usr/bin/env bash
# Root orchestrates systemd/symlink changes; repository code runs as the service user.
set -euo pipefail

state=${INFER_UPDATE_STATE_DIR:-/var/lib/imajin/infer-passthrough}
repo=${INFER_UPDATE_REPO:-$state/repo}
runtime_user=${INFER_UPDATE_USER:-imajin}
port=${INFER_UPDATE_PORT:-8787}
candidate_port=${INFER_UPDATE_CANDIDATE_PORT:-8788}
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
mode=${1:-}
case "$mode" in
  ""|--dry-run|--check) ;;
  *) printf 'Usage: update.sh [--dry-run|--check]\n' >&2; exit 2 ;;
esac
for value in "$port" "$candidate_port"; do
  if [[ ! "$value" =~ ^[1-9][0-9]{0,4}$ ]] || (( value > 65535 )); then
    printf 'Invalid health port\n' >&2
    exit 2
  fi
done
if [[ "$port" == "$candidate_port" ]]; then
  printf 'Candidate and live ports must differ\n' >&2
  exit 2
fi
if [[ "$mode" == --check ]]; then
  exec node "$script_dir/check-health.mjs" "$port"
fi

log() { printf 'infer-passthrough-update: %s\n' "$*"; }
as_user() { runuser -u "$runtime_user" -- "$@"; }
health() {
  local health_port="$1"
  node "$script_dir/check-health.mjs" "$health_port"
}

# One updater at a time. The directory and current link are root-owned.
exec 9>"$state/update.lock"
flock -n 9 || { log 'another updater holds the lock'; exit 1; }
as_user git -C "$repo" fetch --tags origin '+refs/heads/main:refs/remotes/origin/main'
tags_output=$(as_user git -C "$repo" for-each-ref --sort=-v:refname --format='%(refname:short)' refs/tags)
mapfile -t tags <<< "$tags_output"
tag=
for value in "${tags[@]}"; do
  if [[ "$value" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    sha=$(as_user git -C "$repo" rev-parse --verify "refs/tags/$value^{commit}")
    if ! as_user git -C "$repo" merge-base --is-ancestor "$sha" origin/main; then
      log "refusing $value: tag commit is not on origin/main; current release unchanged"
      continue
    fi
    if node "$script_dir/production-deployment.mjs" "$sha"; then
      log "approved $value ($sha): on main with successful production deployment"
    else
      gate_status=$?
      log "refusing $value: no verified successful production deployment; current release unchanged"
      # A lookup failure must not be mistaken for an unapproved tag.
      (( gate_status == 1 )) || exit 1
      continue
    fi
    tag=$value
    break
  fi
done
[[ -n "$tag" ]] || { log 'no stable release tag found with main + production approval; current release unchanged'; exit 1; }
candidate="$state/releases/$sha"
previous=$(readlink -f -- "$state/current") || { log 'current release link is required; see one-time install'; exit 1; }
[[ -d "$previous" && -L "$state/current" ]] || { log 'current must link to an existing checkout'; exit 1; }
log "latest release $tag ($sha) eligible after the production gate"
if [[ "$mode" == --dry-run ]]; then
  log "dry-run: stage $tag; install/build; mint-check candidate /health; promote and restart; rollback to previous checkout if live /health fails"
  exit 0
fi
if [[ "$previous" == "$candidate" ]]; then
  log "already on $tag; checking route mints"
  health "$port"
  exit
fi

candidate_started=false
promoted=false
committed=false
point_current() {
  local target="$1"
  ln -sfn -- "$target" "$state/current.next"
  mv -Tf -- "$state/current.next" "$state/current"
}
finish() {
  result=$?
  trap - EXIT
  if $candidate_started; then
    systemctl stop infer-passthrough-candidate.service || log 'candidate stop failed'
  fi
  if $promoted && ! $committed; then
    log "release $tag failed; rolling back to previous checkout"
    if point_current "$previous" && systemctl restart infer-passthrough.service && health "$port"; then
      log 'rollback healthy'
    else
      log 'ROLLBACK FAILED: operator attention required'
    fi
  elif (( result != 0 )); then
    log "release $tag failed before promotion; previous checkout unchanged"
  fi
  exit "$result"
}
trap finish EXIT
trap 'exit 1' INT TERM

if [[ ! -d "$candidate" ]]; then
  as_user git -C "$repo" worktree add --detach "$candidate" "$sha"
fi
[[ "$(as_user git -C "$candidate" rev-parse HEAD)" == "$sha" ]] || { log 'candidate SHA mismatch'; exit 1; }
[[ -z "$(as_user git -C "$candidate" status --porcelain)" ]] || { log 'candidate has local changes; refusing deployment'; exit 1; }
# No lifecycle scripts or root execution of repository code.
as_user pnpm --dir "$candidate" install --frozen-lockfile --ignore-scripts --loglevel=error
as_user mkdir -p "$state/releases/.turbo"
as_user env TURBO_CACHE_DIR="$state/releases/.turbo" pnpm --dir "$candidate" exec turbo run build --filter=@imajin/auth --output-logs=errors-only

candidate_started=true
systemd-run --unit=infer-passthrough-candidate --collect --service-type=exec \
  --uid="$runtime_user" --working-directory="$candidate" \
  --property=EnvironmentFile=/etc/imajin/infer-passthrough.env \
  --property=TimeoutStopSec=10s --property=KillMode=control-group \
  /usr/bin/env INFER_PROXY_HOST=127.0.0.1 INFER_PROXY_PORT="$candidate_port" \
  "$candidate/node_modules/.bin/tsx" packages/openclaw-infer-passthrough/src/server.ts
health "$candidate_port"
systemctl is-active --quiet infer-passthrough-candidate.service
systemctl stop infer-passthrough-candidate.service
candidate_started=false

# Mark before switching so even a failed symlink/restart enters rollback.
promoted=true
point_current "$candidate"
systemctl restart infer-passthrough.service
health "$port"
committed=true
log "deployed $tag ($sha); all route mints healthy"
