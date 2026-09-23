#!/usr/bin/env node
/**
 * Lockstep workspace version bump, for the Release workflow (#2285).
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
 * ## What this does instead
 *
 * 1. Reads the ROOT `package.json` version as the single source of truth.
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
 *   tracked `package.json` files — no shell interpolation involved.
 *
 * ## Usage
 *
 * `node scripts/bump-workspace-version.mjs <minor|patch>`
 *
 * Prints the new version (e.g. `0.8.1`) to stdout on success.
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
  const currentVersion = JSON.parse(readFileSync(rootPackageJsonPath, 'utf8')).version;
  if (typeof currentVersion !== 'string') {
    console.error(`FAIL: root package.json at ${rootPackageJsonPath} has no "version" field.`);
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
