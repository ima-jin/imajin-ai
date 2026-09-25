#!/usr/bin/env bash
# build-restart-failed.test.sh — regression coverage for scripts/build.sh's
# exit code (#2382).
#
# Before this fix, build.sh's final exit condition folded FAILED and
# PORT_REAP_FAILED into a non-zero exit but silently ignored RESTART_FAILED
# (a service pm2 could neither restart nor cold-start) — a service could be
# down after a deploy and the Actions run would still be green.
#
# This runs the real scripts/build.sh end-to-end (not just a sourced
# function) against a throwaway fake "repo", with pnpm/node/pm2 faked via a
# PATH shim (same technique as reap-orphans.test.sh / pm2-owned.test.sh), and
# asserts on its actual exit code for two scenarios:
#   1. every app builds and every port is clear, but pm2 can neither restart
#      nor cold-start the service -> must exit 2 (the gap this fix closes).
#   2. an app's build genuinely fails -> must still exit 1, unchanged, since
#      deploy-prod.yml/build-changed.sh only check "was the exit non-zero",
#      never the specific value, but the value itself must stay stable.
#
# Usage: scripts/build-restart-failed.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REAL_NODE="$(command -v node)"

FAILURES=0

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    echo "✅ $desc"
  else
    echo "❌ $desc (expected '$expected', got '$actual')"
    FAILURES=$((FAILURES + 1))
  fi
}

assert_contains() {
  local desc="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    echo "✅ $desc"
  else
    echo "❌ $desc (expected output to contain '$needle')"
    FAILURES=$((FAILURES + 1))
  fi
}

# Builds a throwaway "repo" (just enough of the layout build.sh expects —
# scripts/{build.sh,lib/*}, a git history, and one apps/<name> dir) plus a
# PATH-shimmed fake bin dir, then runs build.sh in it.
#
# Args: app_name  has_next_config(true|false)  fail_pnpm_build(true|false)
#       pm2_restart_exit_code
# Sets (via stdout, one line each): EXIT_CODE, then the full captured output.
run_build_sh_scenario() {
  local app="$1" has_next_config="$2" fail_pnpm_build="$3" pm2_restart_exit="$4"
  local outer repo fake_bin name

  outer="$(mktemp -d "${TMPDIR:-/tmp}/build-restart-failed-test.XXXXXX")"
  repo="$outer/reporoot"
  fake_bin="$outer/bin"
  mkdir -p "$repo/scripts/lib" "$repo/apps/$app" "$fake_bin"

  # Real build.sh + its real sourced libs — this test exercises the actual
  # current logic, not a copy that could drift from it.
  cp "$SCRIPT_DIR/build.sh" "$repo/scripts/build.sh"
  cp "$SCRIPT_DIR/lib/build-version.sh" "$repo/scripts/lib/build-version.sh"
  cp "$SCRIPT_DIR/lib/pm2-owned.sh" "$repo/scripts/lib/pm2-owned.sh"
  cp "$SCRIPT_DIR/lib/deploy-skip.sh" "$repo/scripts/lib/deploy-skip.sh"
  echo '{"name":"fake-repo","version":"0.0.0-test"}' > "$repo/package.json"

  if [[ "$has_next_config" = true ]]; then
    echo "module.exports = {};" > "$repo/apps/$app/next.config.js"
  fi

  # Untagged, single-commit git history — enough for build.sh's
  # git rev-parse/rev-list calls and an empty (fallback) compute_git_tag_version.
  git -C "$repo" init -q
  git -C "$repo" config user.email test@example.com
  git -C "$repo" config user.name Test
  git -C "$repo" add -A
  git -C "$repo" commit -q -m init

  # pm2's process name for $app, mirroring build.sh's own pm2_name() (kernel
  # is the only special case, irrelevant to these fixtures).
  name="dev-${app}"

  # Fakes every pnpm invocation build.sh makes (env-check tsx run, workspace
  # package build, the ad-hoc port-lookup tsx script, and `pnpm run build`
  # inside an app dir) — all succeed trivially, except `run build` when
  # $FAKE_PNPM_FAIL_BUILD is set, so scenario 2 can simulate a real build
  # failure without a real pnpm install or Next.js app.
  cat > "$fake_bin/pnpm" <<'EOF'
#!/usr/bin/env bash
if [[ "${FAKE_PNPM_FAIL_BUILD:-}" = "true" && "$*" = "run build" ]]; then
  exit 1
fi
exit 0
EOF
  chmod +x "$fake_bin/pnpm"

  # Passes through to the real node for everything except the two direct
  # `node ...` calls build.sh itself makes (migrate.mjs, and the
  # package.json-version fallback) — pm2-owned.sh's own `node -e` JSON
  # parsing still needs a real interpreter, so it is not faked here.
  cat > "$fake_bin/node" <<EOF
#!/usr/bin/env bash
case "\$1" in
  scripts/migrate.mjs)
    exit 0
    ;;
  -p)
    echo "0.0.0-test"
    exit 0
    ;;
esac
exec "$REAL_NODE" "\$@"
EOF
  chmod +x "$fake_bin/node"

  # Fakes pm2: jlist reports $name as already known/online (so build.sh's
  # "no port + not managed by pm2" skip branch doesn't fire before we ever
  # reach the restart attempt), restart fails with the caller-chosen code,
  # and save is a no-op. `pm2 start` (the cold-start fallback) is never
  # exercised here because the fixture repo has no ecosystem.config.js one
  # level above it, so build.sh's own `[[ -f "$ECOSYSTEM_FILE" ]]` guard
  # short-circuits straight to "could not restart or start".
  cat > "$fake_bin/pm2" <<EOF
#!/usr/bin/env bash
case "\$1" in
  jlist)
    echo '[{"pid":4242,"name":"$name","pm2_env":{"status":"online"}}]'
    ;;
  restart)
    exit $pm2_restart_exit
    ;;
  *)
    exit 0
    ;;
esac
EOF
  chmod +x "$fake_bin/pm2"

  local exit_code=0 output
  output="$(
    cd "$repo" && \
    PATH="$fake_bin:$PATH" \
    FAKE_PNPM_FAIL_BUILD="$fail_pnpm_build" \
    bash "$repo/scripts/build.sh" --dev "$app" 2>&1
  )" || exit_code=$?

  rm -rf "$outer"

  printf '%s\n' "$exit_code"
  printf '%s\n' "$output"
}

if ! command -v git >/dev/null 2>&1; then
  echo "git not found on PATH — cannot run tests (fixtures need a real git history)" >&2
  exit 1
fi

# --- Scenario 1 (#2382 regression): restart AND cold-start both fail, ------
# --- nothing else does -> must exit 2, not 0. ------------------------------
RESULT_1="$(run_build_sh_scenario "svc" false false 1)"
EXIT_1="$(echo "$RESULT_1" | head -1)"
OUTPUT_1="$(echo "$RESULT_1" | tail -n +2)"

assert_eq "RESTART_FAILED-only run exits 2 (was 0 before #2382's fix)" "2" "$EXIT_1"
assert_contains "summary names the service that failed to restart" "$OUTPUT_1" "Restart failures: dev-svc"

# --- Scenario 2: a genuine build failure must still exit 1, unchanged. -----
RESULT_2="$(run_build_sh_scenario "brokenapp" true true 0)"
EXIT_2="$(echo "$RESULT_2" | head -1)"
OUTPUT_2="$(echo "$RESULT_2" | tail -n +2)"

assert_eq "a build FAILED still exits 1 (unchanged by #2382's fix)" "1" "$EXIT_2"
assert_contains "summary names the app that failed to build" "$OUTPUT_2" "Failed: brokenapp"

if [[ "$FAILURES" -gt 0 ]]; then
  echo "$FAILURES assertion(s) failed."
  exit 1
fi
echo "All build.sh RESTART_FAILED exit-code assertions passed."
