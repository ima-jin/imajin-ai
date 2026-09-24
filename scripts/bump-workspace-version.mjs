#!/usr/bin/env node
/**
 * Lockstep workspace version bump, for the Release workflow (#2285, #2349).
 *
 * ## Why this isn't literally `pnpm -r version <bump>`
 *
 * The original design for `.github/workflows/release.yml` called for
 * `pnpm -r version <bump>` to bump every manifest in one shot. That does not
 * do what it looks like it does on the pnpm version this repo actually pins
 * (`packageManager: pnpm@9.15.0`, see root `package.json`):
 *
 *   $ pnpm -r version patch --no-git-tag-version
 *   Scope: 2 of 3 workspace projects
 *   None of the selected packages has a "version" script
 *
 * On pnpm 9, `pnpm -r version <bump>` is parsed as "run the script named
 * `version` in every workspace package with argument `<bump>`" — there is no
 * such script, so the whole thing is a silent no-op (exit 0, nothing
 * changed). The built-in recursive semver-bump behavior that command implies
 * was only added in a much later pnpm major version. Discovering this by
 * hand-testing against the pinned version is what this file's existence is
 * evidence of; a workflow built on the literal command would have shipped a
 * Release workflow that never actually bumps anything.
 *
 * Separately, even a working `pnpm -r version <bump>` would not produce
 * "lockstep" in this repo as-is: workspace packages do not share a single
 * current version today (root/most publishable packages are `0.8.0`, several
 * internal packages are `0.1.0`, `eslint-config-imajin` is `1.0.0`). Bumping
 * each package by its OWN current version independently would widen that
 * divergence instead of collapsing it to one release version.
 *
 * ## Why the base version comes from the latest tag, not package.json (#2349)
 *
 * This used to read root `package.json`'s `"version"` as the single source
 * of truth. That broke the moment a release was cut OUTSIDE this workflow:
 * `v0.8.3`–`v0.8.5` were pushed as manual annotated tags (hot-fix cycles),
 * while root `package.json` stayed at `0.8.2`. The next `bump=patch`
 * dispatch then read `0.8.2`, computed `v0.8.3`, and
 * "Guard against re-using an existing tag" correctly refused to reopen a
 * release for a version already tagged — the workflow was unusable until a
 * human noticed and hand-synced the manifest.
 *
 * `git describe --tags --abbrev=0 --match 'v[0-9]*'` (the same tag-matching
 * this repo already uses in `scripts/lib/build-version.sh` for #2287) is the
 * one thing that can never be behind: every tag this repo creates, by hand or
 * by `tag-release.yml`, is visible to it. Deriving the bump base from the
 * latest reachable tag instead of `package.json` makes drift self-healing —
 * the next dispatch always computes the true next version — rather than a
 * fatal guard failure. `package.json` is still written (lockstep, as
 * before); it's just no longer read as an input.
 *
 * ## What this does
 *
 * 1. Resolves the base version from the latest `vX.Y.Z` tag reachable from
 *    HEAD (leading `v` stripped), falling back to root `package.json`'s
 *    version only when no such tag exists yet (a brand-new repo before its
 *    first release).
 * 2. Bumps it by `<bump>` (`minor` resets patch to 0; `patch` increments
 *    patch) — the same semantics `npm version`/`pnpm version` use for a
 *    prerelease-free `major.minor.patch` string, which is everything in
 *    this repo today.
 * 3. Writes that EXACT resulting version into every tracked `package.json`
 *    in the repo (root + every `apps/*`/`packages/*` manifest), so the
 *    Release workflow's commit puts every package at the same vX.Y.Z —
 *    true lockstep, not independent per-package increments.
 *
 * ## Sonar-clean notes
 *
 * - No PATH-spawn (S4036): `git` is resolved to an absolute path up front
 *   (env override or a fixed list of known install locations), only to list
 *   tracked `package.json` files and describe the latest tag — no shell
 *   interpolation involved.
 *
 * ## Usage
 *
 * `node scripts/bump-workspace-version.mjs <minor|patch>`
 *
 * Prints the new version (e.g. `0.8.6`) to stdout on success.
 *
 * Env overrides (for tests / non-standard checkouts):
 *   - `CI_GUARD_WORKDIR` — repo root (default: one level up from this file)
 *   - `GIT_BIN`          — absolute path to the git binary
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.CI_GUARD_WORKDIR
  ? resolve(process.env.CI_GUARD_WORKDIR)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');

const KNOWN_GIT_LOCATIONS = ['/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git', '/bin/git'];

function resolveGitBinary() {
  if (process.env.GIT_BIN) return process.env.GIT_BIN;
  const found = KNOWN_GIT_LOCATIONS.find((candidate) => existsSync(candidate));
  if (found) return found;
  throw new Error(
    `git binary not found in any of: ${KNOWN_GIT_LOCATIONS.join(', ')}. Set GIT_BIN to its absolute path.`,
  );
}

/** Lists every `package.json` tracked by git in the working tree, root-relative. */
function listPackageJsonFiles(gitBin, root) {
  const out = execFileSync(gitBin, ['ls-files', '--', '*/package.json', 'package.json'], {
    cwd: root,
    encoding: 'utf8',
  });
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.includes('node_modules/'));
}

/**
 * Returns the latest `vX.Y.Z` tag reachable from HEAD (leading `v` stripped),
 * or `undefined` when no such tag exists yet. Same `--match 'v[0-9]*'`
 * restriction as `scripts/lib/build-version.sh` (#2287), for the same reason:
 * a non-version tag must never be mistaken for a release point.
 */
function latestTagVersion(gitBin, root) {
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

/**
 * Resolves the version this run should bump FROM: the latest reachable
 * `vX.Y.Z` tag (tag is truth, #2349), falling back to root `package.json`'s
 * own version only when no such tag exists yet.
 */
export function resolveBaseVersion(gitBin, root, rootPackageJsonPath) {
  const tagVersion = latestTagVersion(gitBin, root);
  if (tagVersion !== undefined) return tagVersion;

  const currentVersion = JSON.parse(readFileSync(rootPackageJsonPath, 'utf8')).version;
  if (typeof currentVersion !== 'string') {
    throw new Error(
      `no vX.Y.Z tag reachable from HEAD, and root package.json at ${rootPackageJsonPath} has no "version" field.`,
    );
  }
  return currentVersion;
}

/** Bumps a plain `major.minor.patch` string the same way `npm version <bump>` would, sans prerelease support. */
export function bumpVersion(current, bump) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!match) {
    throw new Error(`unsupported version format "${current}" — expected plain major.minor.patch`);
  }
  const [, majorStr, minorStr, patchStr] = match;
  const major = Number(majorStr);
  const minor = Number(minorStr);
  const patch = Number(patchStr);

  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  if (bump === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error(`unsupported bump type "${bump}" — expected "minor" or "patch"`);
}

/** Rewrites just the top-level `"version"` field in place, preserving every other byte of the file. */
export function setVersionInFile(filePath, newVersion) {
  const raw = readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  if (typeof parsed.version !== 'string') {
    return false; // no version field to touch — leave the file untouched
  }
  const updated = raw.replace(
    /("version"\s*:\s*")([^"]*)(")/,
    (_whole, prefix, _oldVersion, suffix) => `${prefix}${newVersion}${suffix}`,
  );
  if (updated === raw) {
    throw new Error(`could not locate a rewritable "version" field in ${filePath}`);
  }
  writeFileSync(filePath, updated, 'utf8');
  return true;
}

function main() {
  const bump = process.argv[2];
  if (bump !== 'minor' && bump !== 'patch') {
    console.error('Usage: node scripts/bump-workspace-version.mjs <minor|patch>');
    process.exit(1);
    return;
  }

  const gitBin = resolveGitBinary();
  const rootPackageJsonPath = join(ROOT, 'package.json');

  let currentVersion;
  try {
    currentVersion = resolveBaseVersion(gitBin, ROOT, rootPackageJsonPath);
  } catch (err) {
    console.error(`FAIL: ${err.message}`);
    process.exit(1);
    return;
  }

  const newVersion = bumpVersion(currentVersion, bump);

  const files = listPackageJsonFiles(gitBin, ROOT);
  let touched = 0;
  for (const relPath of files) {
    if (setVersionInFile(join(ROOT, relPath), newVersion)) touched += 1;
  }

  console.error(`bump-workspace-version: ${currentVersion} -> ${newVersion} across ${touched} package.json file(s).`);
  console.log(newVersion);
}

// Guards against side effects when this module is `import`ed for its
// testable helpers (bumpVersion, setVersionInFile) rather than executed
// directly as a script. Compares resolved filesystem paths (not raw URL
// strings) so this also works on Windows, where a bare `file://${argv[1]}`
// comparison would never match (see fileURLToPath vs `.pathname` note in
// scripts/__tests__/*.test.mjs).
if (resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1] ?? '')) {
  main();
}
