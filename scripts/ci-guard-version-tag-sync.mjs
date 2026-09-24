#!/usr/bin/env node
/**
 * Version-tag-sync guard (#2349).
 *
 * ## Why this exists
 *
 * `release.yml` `bump=patch` (run 36031435178) failed at "Guard against
 * re-using an existing tag": it computed `v0.8.3` because root
 * `package.json` was still `0.8.2`, while `v0.8.3`–`v0.8.5` had already been
 * pushed as manual annotated tags (hot-fix cycles) — root `package.json` had
 * silently fallen behind the repo's own tags. `scripts/bump-workspace-version.mjs`
 * now derives the next version from the latest tag instead of `package.json`
 * (self-healing for the Release workflow itself, see that script's header
 * comment), but a stale `package.json` is still a lie the moment anything
 * else reads it (a display value, a support/bug-report script, a human
 * skimming the manifest) — and nothing short of a real diff would otherwise
 * surface a FUTURE recurrence of the exact bypass that caused this one
 * (another manual tag push, or any other route around the Release workflow).
 *
 * ## What it checks
 *
 * Compares root `package.json`'s `"version"` against the latest `vX.Y.Z` tag
 * reachable from HEAD (same `--match 'v[0-9]*'` restriction as
 * `scripts/lib/build-version.sh`, #2287). Fails when `package.json` is
 * strictly behind the tag. Passes (does nothing) when no such tag is
 * reachable yet, or when `package.json` is at or ahead of it — "ahead" is not
 * this guard's concern (that shape, together with `ci-guard-version-bump.mjs`,
 * is what happens mid-release, between the `release:` commit landing and
 * `tag-release.yml` tagging it).
 *
 * ## Why "fail" rather than "self-heal"
 *
 * Two designs were considered: have this guard fail the CI Guards job, or
 * have it push a fixup commit. Self-healing in CI would need a separate
 * bypass-worthy commit (another exemption in `ci-guard-version-bump.mjs`) and
 * a token with write access to whatever branch is being checked, for a
 * situation that should be rare (it requires bypassing the Release workflow
 * in the first place, which AGENTS.md's "Deploy guardrails" section already
 * says never to do). Failing loudly, the same way every other guard in this
 * job already does, is the simpler option and needs no new bypass surface —
 * the fix is always the same one-time `release:` sync commit this issue's own
 * fix shipped as. Sonar-clean notes below explain the implementation choices
 * that keep this in line with its sibling guards.
 *
 * ## Sonar-clean notes
 *
 * - No PATH-spawn (S4036): `git` is resolved to an absolute path up front
 *   (env override or a fixed list of known install locations) rather than
 *   left to PATH lookup.
 *
 * ## Usage
 *
 * `node scripts/ci-guard-version-tag-sync.mjs`
 *
 * Env overrides (for tests / non-standard checkouts):
 *   - `CI_GUARD_WORKDIR` — repo root (default: one level up from this file)
 *   - `GIT_BIN`          — absolute path to the git binary
 */

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.CI_GUARD_WORKDIR
  ? resolve(process.env.CI_GUARD_WORKDIR)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ── git binary resolution (S4036: no PATH-spawn) ────────────────────────────

const KNOWN_GIT_LOCATIONS = ['/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git', '/bin/git'];

function resolveGitBinary() {
  if (process.env.GIT_BIN) return process.env.GIT_BIN;
  const found = KNOWN_GIT_LOCATIONS.find((candidate) => existsSync(candidate));
  if (found) return found;
  throw new Error(
    `git binary not found in any of: ${KNOWN_GIT_LOCATIONS.join(', ')}. Set GIT_BIN to its absolute path.`,
  );
}

/** Best-effort: registers ROOT as a safe.directory so a container job's separate git config doesn't refuse it. */
function ensureSafeDirectory(gitBin, root) {
  try {
    execFileSync(gitBin, ['config', '--global', '--add', 'safe.directory', root], { stdio: 'pipe' });
  } catch {
    // Non-fatal — the workflow step should also do this; this is defense in depth.
  }
}

/**
 * Returns the latest `vX.Y.Z` tag reachable from HEAD (leading `v` stripped),
 * or `undefined` when no such tag exists yet. Same `--match 'v[0-9]*'`
 * restriction as `scripts/lib/build-version.sh` (#2287) and
 * `scripts/bump-workspace-version.mjs` (#2349): a non-version tag must never
 * be mistaken for a release point.
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
    return undefined;
  }
}

/** Parses a plain `major.minor.patch` string into a `[major, minor, patch]` tuple, or `undefined` if it doesn't match. */
export function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? '');
  if (!match) return undefined;
  const [, majorStr, minorStr, patchStr] = match;
  return [Number(majorStr), Number(minorStr), Number(patchStr)];
}

/** Negative when `a` < `b`, positive when `a` > `b`, zero when equal — same contract as a sort comparator. */
export function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function fail(message) {
  console.error(`\nFAIL: ${message}\n`);
  process.exit(1);
}

function main() {
  let gitBin;
  try {
    gitBin = resolveGitBinary();
  } catch (err) {
    fail(err.message);
    return;
  }

  ensureSafeDirectory(gitBin, ROOT);

  const tagVersionRaw = latestTagVersion(gitBin, ROOT);
  if (tagVersionRaw === undefined) {
    console.log('PASS: no vX.Y.Z tag reachable from HEAD yet — nothing to compare package.json against.');
    process.exit(0);
    return;
  }

  const rootPackageJsonPath = join(ROOT, 'package.json');
  let packageVersionRaw;
  try {
    packageVersionRaw = JSON.parse(readFileSync(rootPackageJsonPath, 'utf8')).version;
  } catch (err) {
    fail(`could not read/parse ${rootPackageJsonPath}: ${err.message}`);
    return;
  }

  const tagVersion = parseVersion(tagVersionRaw);
  const packageVersion = parseVersion(packageVersionRaw);

  if (!tagVersion) {
    fail(`latest tag "v${tagVersionRaw}" is not a plain vX.Y.Z tag — cannot compare against package.json.`);
    return;
  }
  if (!packageVersion) {
    fail(`root package.json "version" ("${packageVersionRaw}") is not a plain major.minor.patch string.`);
    return;
  }

  if (compareVersions(packageVersion, tagVersion) < 0) {
    fail(
      `root package.json version (${packageVersionRaw}) is behind the latest tag (v${tagVersionRaw}). ` +
        `This is the exact drift that broke release.yml's "Guard against re-using an existing tag" step in #2349 ` +
        `(a manually-pushed hot-fix tag, or any other bypass of the Release workflow, leaves package.json stale). ` +
        `Sync package.json's version to v${tagVersionRaw} (or later) with a one-time "release: vX.Y.Z" commit ` +
        `(see AGENTS.md's "Versioning" section) before this can pass.`,
    );
    return;
  }

  console.log(`PASS: root package.json version (${packageVersionRaw}) is not behind the latest tag (v${tagVersionRaw}).`);
  process.exit(0);
}

// Guards against side effects when this module is `import`ed for its testable
// helpers (latestTagVersion, parseVersion, compareVersions) rather than
// executed directly as a script. Compares resolved filesystem paths (not raw
// URL strings) so this also works on Windows — see the identical note in
// scripts/bump-workspace-version.mjs.
if (resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1] ?? '')) {
  main();
}
