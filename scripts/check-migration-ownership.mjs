#!/usr/bin/env node
/**
 * Schema-boundary CI guard for migrations (#1991 phase 1).
 *
 * ## Why this exists
 *
 * Every app's tables live in the single root `migrations/`, interleaved with
 * every other app's and the kernel's (see migrations/OWNERSHIP.md). Nothing
 * stopped one app's migration from creating, altering, or dropping a table
 * that conceptually belongs to another app or to the kernel — a schema
 * ownership violation that should instead go through the kernel's HTTP API.
 * `migrations/OWNERSHIP.md` + `ownership.json` name who owns what; this
 * guard is what makes drift from that map a CI failure.
 *
 * ## What it checks
 *
 * For every migration file changed or added in this PR (`git diff` against
 * the base branch), the file must declare its owner with a leading
 * `-- owner: <name>` comment line. Every table/view/type/function the file's
 * statements touch is looked up in `migrations/ownership.json`:
 *   - Already registered under a DIFFERENT owner than the file declares →
 *     FAIL (schema-boundary violation).
 *   - A brand-new identity (not registered at all) → FAIL unless this PR's
 *     `ownership.json` was also updated to include it (so the map can never
 *     silently drift out of date).
 *   - Registered under the SAME owner → fine.
 *
 * A NEW migration file (git status `A`) with no `-- owner:` header fails
 * with instructions. A pre-existing migration file that this PR merely
 * touches (git status anything other than `A`) is grandfathered when it has
 * no header — migrations are meant to be immutable, so retrofitting headers
 * onto history is not this guard's job. Files the PR does not change at all
 * are never inspected.
 *
 * ## Shared-schema check (#1991 phase 2a)
 *
 * Separately from the per-table checks above, a NEW migration file whose
 * SQL (DDL or DML — see `lib/migration-schema-scan.mjs`) references more
 * than one owner's schema anywhere fails, unless it's listed in
 * `migrations/ownership.json`'s `sharedMigrationAllowlist`. This is a
 * stricter, forward-looking rule: existing shared files (`0001_seed.sql`,
 * and two `dykil` data migrations that join `events` tables) predate it
 * and are grandfathered there. New cross-owner migrations should not
 * happen at all — split them into one file per owner — but the allowlist
 * exists as a documented, reviewed escape hatch rather than a hard block.
 *
 * ## Running inside a container-based CI job
 *
 * `actions/checkout` registers `safe.directory` in the *runner host's*
 * global git config. A `container:`-based job step runs git inside a
 * separate container filesystem/HOME, which never sees that config — git
 * then refuses to resolve refs in the checked-out repo at all. The
 * workflow step should add `safe.directory` itself (see ci.yml), but this
 * script also does it defensively before diffing, and falls back to a
 * shallow `git fetch` of the base ref if it's simply missing locally, so a
 * misconfigured environment degrades to a clear message instead of a raw
 * git stack trace.
 *
 * ## Sonar-clean notes
 *
 * - No PATH-spawn (S4036): `git` is resolved to an absolute path up front
 *   (env override or a fixed list of known install locations) rather than
 *   left to PATH lookup.
 *
 * ## Usage
 *
 * `node scripts/check-migration-ownership.mjs`
 *
 * Env overrides (for tests / non-standard checkouts):
 *   - `CI_GUARD_WORKDIR`             — repo root (default: two levels up from this file)
 *   - `MIGRATION_OWNERSHIP_BASE_REF` — git ref to diff against (default: `origin/main`)
 *   - `GIT_BIN`                      — absolute path to the git binary
 */

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStatements, ALL_OWNERS, BUCKET_FOR_KIND } from './lib/migration-ownership-parser.mjs';
import { detectTouchedOwners } from './lib/migration-schema-scan.mjs';

const ROOT = process.env.CI_GUARD_WORKDIR
  ? resolve(process.env.CI_GUARD_WORKDIR)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE_REF = process.env.MIGRATION_OWNERSHIP_BASE_REF || 'origin/main';
const MIGRATIONS_DIR = join(ROOT, 'migrations');
const OWNERSHIP_PATH = join(MIGRATIONS_DIR, 'ownership.json');

const OWNER_HEADER_RE = /^--\s*owner:\s*([a-z0-9_-]+)\s*$/im;

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

// ── git diff against the base branch ────────────────────────────────────────

/** Best-effort: registers ROOT as a safe.directory so a container job's separate git config doesn't refuse it. */
function ensureSafeDirectory(gitBin, root) {
  try {
    execFileSync(gitBin, ['config', '--global', '--add', 'safe.directory', root], { stdio: 'pipe' });
  } catch {
    // Non-fatal — the workflow step already does this; this is defense in
    // depth for environments that invoke this script differently.
  }
}

function diffNameStatus(gitBin, root, baseRef) {
  const args = ['diff', '--no-color', '--name-status', `${baseRef}...HEAD`, '--', 'migrations'];
  return execFileSync(gitBin, args, { cwd: root, encoding: 'utf8' });
}

/** Splits a `baseRef` like "origin/main" into `["origin", "main"]` for `git fetch`. */
function splitRemoteRef(baseRef) {
  const slash = baseRef.indexOf('/');
  return slash === -1 ? ['origin', baseRef] : [baseRef.slice(0, slash), baseRef.slice(slash + 1)];
}

/**
 * Fetches the base ref shallowly, for when it's simply missing locally
 * (fresh/shallow/single-branch checkouts). Uses an explicit `src:dst`
 * refspec so the remote-tracking ref actually lands at
 * `refs/remotes/<remote>/<branch>` — a plain `git fetch origin main` only
 * updates FETCH_HEAD when the remote's configured fetch refspec doesn't
 * already cover that branch (e.g. a `--single-branch` clone).
 */
function fetchBaseRef(gitBin, root, baseRef) {
  const [remote, branch] = splitRemoteRef(baseRef);
  execFileSync(gitBin, ['fetch', remote, `${branch}:refs/remotes/${remote}/${branch}`, '--depth=1'], {
    cwd: root,
    stdio: 'pipe',
  });
}

function parseDiffLine(line) {
  const [status, ...pathParts] = line.split('\t');
  // Renames are "R100\told\tnew" — the new path is what's on disk now.
  return { status: status[0], filePath: pathParts[pathParts.length - 1] };
}

function parseDiffOutput(output) {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseDiffLine)
    .filter(({ filePath }) => filePath.endsWith('.sql'));
}

/** Returns `{ status, filePath }[]` for every migrations/*.sql file changed or added versus `baseRef`. */
function getChangedMigrationFiles(root, baseRef) {
  const gitBin = resolveGitBinary();
  ensureSafeDirectory(gitBin, root);

  let output;
  try {
    output = diffNameStatus(gitBin, root, baseRef);
  } catch (firstErr) {
    try {
      fetchBaseRef(gitBin, root, baseRef);
      output = diffNameStatus(gitBin, root, baseRef);
    } catch {
      throw new Error(
        `could not diff against "${baseRef}" (a fallback "git fetch ${baseRef}" was also tried and failed). ` +
          `Original error: ${firstErr.message.split('\n')[0]}`,
      );
    }
  }

  return parseDiffOutput(output);
}

// ── ownership map ────────────────────────────────────────────────────────────

function loadOwnershipMap() {
  if (!existsSync(OWNERSHIP_PATH)) {
    throw new Error(`${OWNERSHIP_PATH} does not exist.`);
  }
  return JSON.parse(readFileSync(OWNERSHIP_PATH, 'utf8'));
}

/**
 * Filenames explicitly permitted to touch more than one owner's schema —
 * pre-existing shared files grandfathered at the time this check was
 * introduced (#1991 phase 2a), or a later deliberate, reviewed exception
 * added in the same PR that adds it. See `migrations/OWNERSHIP.md`'s
 * "Shared migrations" section.
 */
function loadSharedMigrationAllowlist(ownershipMap) {
  return new Set(ownershipMap.sharedMigrationAllowlist ?? []);
}

// ── per-file checks ──────────────────────────────────────────────────────────

function extractDeclaredOwner(sql) {
  const match = OWNER_HEADER_RE.exec(sql);
  return match ? match[1] : null;
}

/**
 * Resolves this file's declared owner, or `null` when the file should be
 * skipped entirely (grandfathered pre-existing file with no header).
 * Returns a violation message instead when a NEW file is missing its header.
 */
function resolveDeclaredOwner(filePath, sql, isNew) {
  const declaredOwner = extractDeclaredOwner(sql);
  if (declaredOwner) return { declaredOwner };
  if (!isNew) return { declaredOwner: null }; // grandfathered, skip silently

  return {
    declaredOwner: null,
    violation:
      `${filePath}: new migration is missing a "-- owner: <name>" header line. ` +
      `Add one near the top of the file, e.g. "-- owner: coffee". ` +
      `Valid owners: ${[...ALL_OWNERS].join(', ')}.`,
  };
}

function checkOwnerIsKnown(filePath, declaredOwner) {
  if (ALL_OWNERS.has(declaredOwner)) return null;
  return `${filePath}: declared owner "${declaredOwner}" is not a known owner. Valid owners: ${[...ALL_OWNERS].join(', ')}.`;
}

/**
 * Reduces a migration's parsed statements to the set of (kind, schema, name)
 * identities it "touches" — created, altered, dropped, or renamed (touching
 * both the old and new name) — deduped so a RENAME (which matches both the
 * generic 'alter' and the specific 'rename' pattern) is reported once.
 */
function collectTouches(statements) {
  const ACTION_RANK = { create: 3, rename: 2, alter: 1, drop: 1 };
  const byKey = new Map();

  const consider = (touch) => {
    const key = `${touch.kind}:${touch.schema}.${touch.name}`;
    const existing = byKey.get(key);
    if (!existing || (ACTION_RANK[touch.action] ?? 0) > (ACTION_RANK[existing.action] ?? 0)) {
      byKey.set(key, touch);
    }
  };

  for (const stmt of statements) {
    consider({ kind: stmt.kind, schema: stmt.schema, name: stmt.name, action: stmt.action });
    if (stmt.action === 'rename' && stmt.renameTo) {
      consider({ kind: stmt.kind, schema: stmt.schema, name: stmt.renameTo, action: 'create' });
    }
  }

  return [...byKey.values()];
}

/** Checks one touched identity against the ownership map. Returns a violation message, or `null` when clean. */
function checkTouch(filePath, touch, ownershipMap, declaredOwner) {
  const bucket = ownershipMap[BUCKET_FOR_KIND[touch.kind]] ?? {};
  const key = `${touch.schema}.${touch.name}`;
  const registered = bucket[key];

  if (!registered) {
    if (touch.action !== 'create') return null; // predates the map, or a scratch object — not this guard's concern
    return (
      `${filePath}: creates ${key} (${touch.kind}) but it is not registered in migrations/ownership.json. ` +
      `Add an entry under "${BUCKET_FOR_KIND[touch.kind]}" with owner "${declaredOwner}" in this PR.`
    );
  }

  if (registered.owner === declaredOwner) return null;
  return (
    `${filePath}: touches ${key} (${touch.kind}), which migrations/ownership.json lists as owned by ` +
    `"${registered.owner}", but this migration declares "-- owner: ${declaredOwner}". ` +
    `Cross-schema writes are a contract violation — go through ${registered.owner}'s API instead, ` +
    `or if ${declaredOwner} is genuinely taking ownership, update ownership.json in the same PR.`
  );
}

/**
 * A brand-new migration file (git status `A`) that references more than
 * one owner's schema anywhere in its SQL (DDL or DML — see
 * `migration-schema-scan.mjs`) is a violation unless it's in the explicit
 * `sharedMigrationAllowlist`. Pre-existing shared files (e.g.
 * `0001_seed.sql`) are grandfathered via that allowlist rather than by the
 * `isNew` check alone, so they stay clean even if a future PR legitimately
 * re-touches one (a `git status` other than `A` at that point, but the
 * allowlist keeps the intent documented and enforceable either way).
 */
function checkSharedSchemaViolation(filePath, sql, isNew, allowlist) {
  if (!isNew) return null;
  if (allowlist.has(basename(filePath))) return null;

  const owners = detectTouchedOwners(sql);
  if (owners.size <= 1) return null;

  return (
    `${filePath}: new migration touches more than one owner's schema ` +
    `(${[...owners].sort((a, b) => a.localeCompare(b)).join(', ')}). A migration may only create, alter, or otherwise touch one ` +
    `owner's schema — split this into one file per owner. If this is a deliberate, reviewed exception ` +
    `(e.g. a one-time cross-owner data migration), add "${basename(filePath)}" to migrations/ownership.json's ` +
    `"sharedMigrationAllowlist" in this same PR.`
  );
}

function checkFile(filePath, status, ownershipMap, sharedMigrationAllowlist) {
  const sql = readFileSync(join(ROOT, filePath), 'utf8');
  const isNew = status === 'A';

  const sharedViolation = checkSharedSchemaViolation(filePath, sql, isNew, sharedMigrationAllowlist);

  const { declaredOwner, violation: headerViolation } = resolveDeclaredOwner(filePath, sql, isNew);
  if (headerViolation) return [sharedViolation, headerViolation].filter(Boolean);
  if (!declaredOwner) return [sharedViolation].filter(Boolean); // grandfathered

  const ownerViolation = checkOwnerIsKnown(filePath, declaredOwner);
  if (ownerViolation) return [sharedViolation, ownerViolation].filter(Boolean);

  const touches = collectTouches(parseStatements(sql));
  const touchViolations = touches.map((touch) => checkTouch(filePath, touch, ownershipMap, declaredOwner)).filter(Boolean);
  return [sharedViolation, ...touchViolations].filter(Boolean);
}

// ── main ─────────────────────────────────────────────────────────────────────

function reportAndExit(violations) {
  if (violations.length === 0) {
    console.log('PASS: no migration ownership violations found.');
    process.exit(0);
  }

  console.error(`\nFAIL: ${violations.length} migration ownership violation(s) found:\n`);
  for (const violation of violations) {
    console.error(`  - ${violation}`);
  }
  process.exit(1);
}

function main() {
  let ownershipMap;
  let changedFiles;
  try {
    ownershipMap = loadOwnershipMap();
    changedFiles = getChangedMigrationFiles(ROOT, BASE_REF);
  } catch (err) {
    console.error(`check-migration-ownership: ${err.message}`);
    process.exit(1);
    return;
  }

  const sharedMigrationAllowlist = loadSharedMigrationAllowlist(ownershipMap);

  const violations = changedFiles
    .filter(({ status }) => status !== 'D') // deleted files have nothing left to parse
    .flatMap(({ status, filePath }) => checkFile(filePath, status, ownershipMap, sharedMigrationAllowlist));

  reportAndExit(violations);
}

main();
