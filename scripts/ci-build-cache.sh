#!/bin/bash
# CI build-cache helper (#2605).
#
# The runner box keeps one host directory (/srv/ci/turbo-cache, mounted into
# the job container and exported as TURBO_CACHE_DIR) for two kinds of cache:
#
#   <dir>/<hash>.tar.zst, <hash>-meta.json, ...   Turborepo task cache (turbo
#                                                 owns these; local only)
#   <dir>/next-cache/<app>/                       each Next.js app's .next/cache
#                                                 (webpack/swc incremental
#                                                 build state), keyed per app
#
# `.next/cache/**` is deliberately NOT a turbo output (see turbo.json): it is
# large (~250 MB per app) and changes on every build, so it would churn the
# turbo cache. Instead, apps that still have to rebuild start from the last
# build's .next/cache.
#
# Only apps whose turbo `build` is a cache MISS are restored/saved. An app that
# turbo replays never reads .next/cache, and copying it in and out would burn
# the time the turbo cache just saved. `restore-next` asks turbo for the plan
# (`--dry=json`, same environment and checkout as the real build, so the hashes
# match) and records it for `save-next`, which runs after the build when every
# app would look like a HIT.
#
# Five runners share the box, so two jobs can build the same app at once. Jobs
# therefore never build *in* the shared directory: `restore-next` copies it into
# the workspace, `save-next` publishes a private copy back via a rename (last
# writer wins; a lost race just drops that job's copy). A corrupt or missing
# cache only costs a cold build — Next.js revalidates what it reads.
#
# Usage (from anywhere; run `restore-next` and `build` with the same env):
#   scripts/ci-build-cache.sh restore-next    before the build
#   scripts/ci-build-cache.sh save-next       after a successful build
#   scripts/ci-build-cache.sh prune [days]    drop turbo entries older than N
#                                             days (default 14)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CACHE_DIR="${TURBO_CACHE_DIR:-}"

if [[ -z "$CACHE_DIR" ]]; then
  echo "::error::TURBO_CACHE_DIR is not set — nothing to persist the build cache in" >&2
  exit 1
fi

NEXT_CACHE_ROOT="$CACHE_DIR/next-cache"
# .turbo/ is gitignored and per-workspace, so concurrent runners never share it.
PLAN_FILE="$REPO_ROOT/.turbo/next-cache-plan"

# Prints the directory name of every app whose build is `next build`.
list_next_apps() {
  local pkg
  for pkg in "$REPO_ROOT"/apps/*/package.json; do
    if grep -q '"build": *"next build' "$pkg"; then
      basename "$(dirname "$pkg")"
    fi
  done
}

# Prints only the Next.js apps whose turbo `build` would miss the cache. Falls
# back to every Next app when the plan cannot be read: a wasted copy beats a
# missed cache.
list_next_apps_to_build() {
  local plan
  if plan="$(cd "$REPO_ROOT" && pnpm exec turbo run build --dry=json 2>/dev/null)" \
    && printf '%s' "$plan" | node -e '
      let raw = "";
      process.stdin.on("data", (chunk) => { raw += chunk; });
      process.stdin.on("end", () => {
        for (const task of JSON.parse(raw).tasks ?? []) {
          if (task.command?.startsWith("next build") && task.cache?.status === "MISS") {
            console.log(task.directory.replace(/^apps\//, ""));
          }
        }
      });
    '; then
    return 0
  fi
  echo "::warning::next-cache: could not read the turbo plan, treating every Next app as rebuilding" >&2
  list_next_apps
}

restore_next() {
  local app src dest
  local apps
  apps="$(list_next_apps_to_build)"
  mkdir -p "$(dirname "$PLAN_FILE")"
  printf '%s\n' "$apps" > "$PLAN_FILE"

  if [[ -z "$apps" ]]; then
    echo "next-cache: every Next app replays from the turbo cache, nothing to restore"
    return 0
  fi
  for app in $apps; do
    src="$NEXT_CACHE_ROOT/$app"
    dest="$REPO_ROOT/apps/$app/.next/cache"
    if [[ ! -d "$src" ]]; then
      echo "next-cache: $app: no saved cache (cold build)"
      continue
    fi
    mkdir -p "$dest"
    if cp -a "$src/." "$dest/"; then
      echo "next-cache: $app: restored $(du -sh "$src" | cut -f1)"
    else
      echo "::warning::next-cache: $app: restore failed, building cold"
      rm -rf "$dest"
    fi
  done
}

save_next() {
  local app src dest tmp old
  local apps
  if [[ -f "$PLAN_FILE" ]]; then
    apps="$(cat "$PLAN_FILE")"
  else
    apps="$(list_next_apps)"
  fi
  if [[ -z "$apps" ]]; then
    echo "next-cache: no Next app rebuilt, nothing to save"
    return 0
  fi

  mkdir -p "$NEXT_CACHE_ROOT"
  for app in $apps; do
    src="$REPO_ROOT/apps/$app/.next/cache"
    dest="$NEXT_CACHE_ROOT/$app"
    if [[ ! -d "$src" ]]; then
      echo "next-cache: $app: no .next/cache produced, nothing to save"
      continue
    fi
    tmp="$NEXT_CACHE_ROOT/.$app.tmp.$$"
    old="$NEXT_CACHE_ROOT/.$app.old.$$"
    rm -rf "$tmp" "$old"
    if ! cp -a "$src" "$tmp"; then
      echo "::warning::next-cache: $app: save failed"
      rm -rf "$tmp"
      continue
    fi
    # Swap in the new copy. If another job swapped first, keep theirs.
    if [[ -d "$dest" ]] && ! mv "$dest" "$old"; then
      echo "next-cache: $app: another job is swapping the cache, continuing"
    fi
    if mv -T "$tmp" "$dest"; then
      echo "next-cache: $app: saved $(du -sh "$dest" | cut -f1)"
    else
      echo "next-cache: $app: another job saved first, dropping this copy"
      rm -rf "$tmp"
    fi
    rm -rf "$old"
  done
}

# The cache is append-only, so it needs a ceiling. Entries older than the
# window are deleted; anything still wanted is simply rebuilt and re-cached.
prune() {
  local days="${1:-14}"
  if [[ ! "$days" =~ ^[0-9]+$ ]]; then
    echo "::error::prune: max-age-days must be a whole number, got '$days'" >&2
    exit 2
  fi
  find "$CACHE_DIR" -maxdepth 1 -type f -mtime "+$days" -delete
  if [[ -d "$NEXT_CACHE_ROOT" ]]; then
    # Orphaned temp copies from killed jobs.
    find "$NEXT_CACHE_ROOT" -maxdepth 1 \( -name '.*.tmp.*' -o -name '.*.old.*' \) -mmin +120 -exec rm -rf {} +
  fi
  echo "turbo-cache: pruned entries older than ${days}d; now $(du -sh "$CACHE_DIR" | cut -f1)"
}

case "${1:-}" in
  restore-next) restore_next ;;
  save-next) save_next ;;
  prune) prune "${2:-14}" ;;
  *)
    echo "usage: $0 restore-next | save-next | prune [max-age-days]" >&2
    exit 2
    ;;
esac
