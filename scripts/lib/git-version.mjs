/**
 * Shared git-binary resolution + tag-version helpers for the release/version
 * CI guards (#2285, #2349).
 *
 * `scripts/ci-guard-version-tag-sync.mjs`, `scripts/bump-workspace-version.mjs`,
 * and `scripts/ci-guard-version-bump.mjs` all need to resolve an absolute path
 * to the `git` binary (S4036: no PATH-spawn) and, in two of the three cases,
 * the latest `vX.Y.Z` tag reachable from HEAD. This module is the single
 * source of truth for both, so the three scripts import it instead of
 * copy-pasting it.
 *
 * ## Sonar-clean notes
 *
 * - No PATH-spawn (S4036): `git` is resolved to an absolute path up front
 *   (env override or a fixed list of known install locations) rather than
 *   left to PATH lookup.
 *
 * Env overrides (for tests / non-standard checkouts):
 *   - `GIT_BIN` — absolute path to the git binary
 */

import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// ── git binary resolution (S4036: no PATH-spawn) ────────────────────────────

export const KNOWN_GIT_LOCATIONS = ['/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git', '/bin/git'];

export function resolveGitBinary() {
  if (process.env.GIT_BIN) return process.env.GIT_BIN;
  const found = KNOWN_GIT_LOCATIONS.find((candidate) => existsSync(candidate));
  if (found) return found;
  throw new Error(
    `git binary not found in any of: ${KNOWN_GIT_LOCATIONS.join(', ')}. Set GIT_BIN to its absolute path.`,
  );
}

/** Best-effort: registers `root` as a safe.directory so a container job's separate git config doesn't refuse it. */
export function ensureSafeDirectory(gitBin, root) {
  try {
    execFileSync(gitBin, ['config', '--global', '--add', 'safe.directory', root], { stdio: 'pipe' });
  } catch {
    // Non-fatal — the workflow step should also do this; this is defense in depth.
  }
}

/**
 * Returns the latest `vX.Y.Z` tag reachable from HEAD (leading `v` stripped),
 * or `undefined` when no such tag exists yet. Same `--match 'v[0-9]*'`
 * restriction as `scripts/lib/build-version.sh` (#2287): a non-version tag
 * must never be mistaken for a release point.
 */
export function latestTagVersion(gitBin, root) {
  try {
    const out = execFileSync(gitBin, ['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out ? out.replace(/^v/, '') : undefined;
  } catch {
    // `git describe` exits non-zero when no matching tag is reachable at all
    // (e.g. a brand-new repo before its first release) — not fatal here.
    return undefined;
  }
}
