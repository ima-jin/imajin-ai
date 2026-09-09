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
 * `migrations/OWNERSHIP.md` + `ownership.json` name who owns what;  this
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
 * ## Usage
 *
 * `node scripts/check-migration-ownership.mjs`
 *
 * Env overrides (for tests / non-standard checkouts):
 *   - `CI_GUARD_WORKDIR`      — repo root (default: two levels up from this file)
 *   - `MIGRATION_OWNERSHIP_BASE_REF` — git ref to diff against (default: `origin/main`)
 */

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStatements, stripSqlComments } from './lib/migration-ownership-parser.mjs';

const ROOT = process.env.CI_GUARD_WORKDIR
  ? resolve(process.env.CI_GUARD_WORKDIR)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE_REF = process.env.MIGRATION_OWNERSHIP_BASE_REF || 'origin/main';
const MIGRATIONS_DIR = join(ROOT, 'migrations');
const OWNERSHIP_PATH = join(MIGRATIONS_DIR, 'ownership.json');

const KNOWN_OWNERS = new Set([
  'kernel',
  'coffee',
  'dykil',
  'links',
  'learn',
  'events',
  'market',
  'broker-agent',
  'corpus',
]);

const OWNER_HEADER_RE = /^--\s*owner:\s*([a-z0-9_-]+)\s*$/im;

const BUCKET_FOR_KIND = { table: 'tables', view: 'views', type: 'types', function: 'functions' };

/** Runs `git diff --name-status <base>...HEAD -- migrations` and returns `{ filename, status }[]`. */
function getChangedMigrationFiles(root, baseRef) {
  const args = ['diff', '--no-color', '--name-status', `${baseRef}...HEAD`, '--', 'migrations'];
  const output = execFileSync('git', args, { cwd: root, encoding: 'utf8' });

  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [status, ...pathParts] = line.split('\t');
      // Renames are "R100\told\tnew" — the new path is what's on disk now.
      const filePath = pathParts[pathParts.length - 1];
      return { status: status[0], filePath };
    })
    .filter(({ filePath }) => filePath.endsWith('.sql'));
}

function loadOwnershipMap() {
  if (!existsSync(OWNERSHIP_PATH)) {
    console.error(`check-migration-ownership: ${OWNERSHIP_PATH} does not exist.`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(OWNERSHIP_PATH, 'utf8'));
}

function extractDeclaredOwner(sql) {
  const match = OWNER_HEADER_RE.exec(sql);
  return match ? match[1] : null;
}

/**
 * Reduce a migration's parsed statements to the set of (kind, schema, name)
 * identities it "touches" — created, altered, dropped, or renamed
 * (touching both the old and new name).
 */
function collectTouches(statements) {
  const touches = [];
  for (const stmt of statements) {
    touches.push({ kind: stmt.kind, schema: stmt.schema, name: stmt.name, action: stmt.action });
    if (stmt.action === 'rename' && stmt.renameTo) {
      touches.push({ kind: stmt.kind, schema: stmt.schema, name: stmt.renameTo, action: 'create' });
    }
  }
  return touches;
}

/** Generic `ALTER TABLE <name> ...` detector (any alter, not just RENAME TO). */
const ALTER_TABLE_RE = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?"?([A-Za-z_][A-Za-z0-9_]*)"?(?:\."?([A-Za-z_][A-Za-z0-9_]*)"?)?/gi;

function collectAlterTouches(sql) {
  const cleaned = stripSqlComments(sql);
  const touches = [];
  ALTER_TABLE_RE.lastIndex = 0;
  let match = ALTER_TABLE_RE.exec(cleaned);
  while (match !== null) {
    const [, first, second] = match;
    const { schema, name } = second ? { schema: first, name: second } : { schema: 'public', name: first };
    touches.push({ kind: 'table', schema, name, action: 'alter' });
    match = ALTER_TABLE_RE.exec(cleaned);
  }
  return touches;
}

/** Collapses duplicate (kind, schema, name) touches, preferring 'create' > 'rename' > others. */
function dedupeTouches(touches) {
  const ACTION_RANK = { create: 3, rename: 2, alter: 1, drop: 1 };
  const byKey = new Map();
  for (const touch of touches) {
    const key = `${touch.kind}:${touch.schema}.${touch.name}`;
    const existing = byKey.get(key);
    if (!existing || (ACTION_RANK[touch.action] ?? 0) > (ACTION_RANK[existing.action] ?? 0)) {
      byKey.set(key, touch);
    }
  }
  return [...byKey.values()];
}

function checkFile(filePath, status, ownershipMap) {
  const violations = [];
  const absolutePath = join(ROOT, filePath);
  const sql = readFileSync(absolutePath, 'utf8');
  const isNew = status === 'A';

  const declaredOwner = extractDeclaredOwner(sql);

  if (!declaredOwner) {
    if (isNew) {
      violations.push(
        `${filePath}: new migration is missing a "-- owner: <name>" header line. ` +
          `Add one near the top of the file, e.g. "-- owner: coffee". ` +
          `Valid owners: ${[...KNOWN_OWNERS].join(', ')}.`,
      );
    }
    // Pre-existing file touched without a header: grandfathered, skip entirely.
    return violations;
  }

  if (!KNOWN_OWNERS.has(declaredOwner)) {
    violations.push(
      `${filePath}: declared owner "${declaredOwner}" is not a known owner. ` +
        `Valid owners: ${[...KNOWN_OWNERS].join(', ')}.`,
    );
    return violations;
  }

  const statements = parseStatements(sql);
  const touches = dedupeTouches([...collectTouches(statements), ...collectAlterTouches(sql)]);

  for (const touch of touches) {
    const bucketName = BUCKET_FOR_KIND[touch.kind];
    const bucket = ownershipMap[bucketName] ?? {};
    const key = `${touch.schema}.${touch.name}`;
    const registered = bucket[key];

    if (!registered) {
      if (touch.action === 'create') {
        violations.push(
          `${filePath}: creates ${key} (${touch.kind}) but it is not registered in migrations/ownership.json. ` +
            `Add an entry under "${bucketName}" with owner "${declaredOwner}" in this PR.`,
        );
      }
      // Non-create touches on unregistered identities aren't this guard's
      // concern (e.g. a name that predates the map, or a scratch object).
      continue;
    }

    if (registered.owner !== declaredOwner) {
      violations.push(
        `${filePath}: touches ${key} (${touch.kind}), which migrations/ownership.json lists as owned by ` +
          `"${registered.owner}", but this migration declares "-- owner: ${declaredOwner}". ` +
          `Cross-schema writes are a contract violation — go through ${registered.owner}'s API instead, ` +
          `or if ${declaredOwner} is genuinely taking ownership, update ownership.json in the same PR.`,
      );
    }
  }

  return violations;
}

function main() {
  const ownershipMap = loadOwnershipMap();

  let changedFiles;
  try {
    changedFiles = getChangedMigrationFiles(ROOT, BASE_REF);
  } catch (err) {
    console.error(`check-migration-ownership: failed to diff against ${BASE_REF}: ${err.message}`);
    process.exit(1);
    return;
  }

  const allViolations = [];
  for (const { status, filePath } of changedFiles) {
    if (status === 'D') continue; // deleted files have nothing left to parse
    allViolations.push(...checkFile(filePath, status, ownershipMap));
  }

  if (allViolations.length > 0) {
    console.error(`\nFAIL: ${allViolations.length} migration ownership violation(s) found:\n`);
    for (const violation of allViolations) {
      console.error(`  - ${violation}`);
    }
    process.exit(1);
  }

  console.log('PASS: no migration ownership violations found.');
  process.exit(0);
}

main();
