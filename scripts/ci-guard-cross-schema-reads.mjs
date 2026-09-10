#!/usr/bin/env node
/**
 * Runtime cross-schema query guard (#2155, item 3).
 *
 * ## Why this exists
 *
 * `migrations/ownership.json` (#1991 phase 1) says who owns every Postgres
 * schema in this repo, and `scripts/check-migration-ownership.mjs` enforces
 * that boundary at the *migration* (DDL) level. Nothing enforced it at the
 * *runtime* (application code) level — the actual gaps that map's "Gaps"
 * section documents: `apps/learn`, `apps/market`, and (heaviest) `apps/events`
 * reading and writing kernel-owned tables directly via raw SQL instead of
 * going through the kernel's HTTP API. This guard is what turns a new
 * instance of that pattern into a CI failure.
 *
 * ## What it checks
 *
 * For every source file under `apps/<x>/**` where `<x>` is not `kernel`
 * (kernel is exempt — it legitimately owns and may read every kernel
 * schema), the guard looks for two things static analysis can reliably spot
 * without a full SQL/TS parser (the same `rg`/grep-based methodology the
 * #1983 audit used):
 *
 *   1. **Raw SQL schema-qualified references**: `FROM`, `JOIN`, `INTO`, or
 *      `UPDATE` followed by `schema.table` — the shape every raw
 *      `getClient()`/`sql\`...\`` cross-schema query in this repo takes.
 *   2. **Drizzle `pgSchema(...)` declarations**: an app declaring a Drizzle
 *      schema object for a schema it does not own (none exist today — every
 *      app's `src/db/schema.ts` only declares its own — but this catches a
 *      future cross-app Drizzle table import before it ships).
 *
 * A match is a violation when the referenced schema is a *known* schema
 * (registered in `migrations/ownership.json`) owned by someone other than
 * `<x>`. Unknown identifiers (most `word.word` matches in ordinary code —
 * e.g. `authResult.error`) are never flagged, because "FROM x.y"/"JOIN x.y"/
 * "INTO x.y"/"UPDATE x.y" essentially only ever occurs inside embedded SQL
 * text, and requiring the schema to be a real, registered one is an extra
 * filter against coincidental matches.
 *
 * Test files (`__tests__/`, `*.test.ts(x)`, `*.spec.ts(x)`) and Drizzle's
 * generated introspection output (`apps/<x>/drizzle/**`) are excluded —
 * neither runs in production, and OWNERSHIP.md already documents the
 * `drizzle/` output as introspection-cosmetic, not an ownership signal.
 *
 * ## Allowlist
 *
 * This guard is introduced with real, pre-existing violations still in the
 * tree (see `migrations/OWNERSHIP.md`'s Gaps section). Rather than either
 * ignoring them (defeating the point) or failing main immediately (blocking
 * unrelated work), known violations are listed in
 * `migrations/cross-schema-allowlist.json`, keyed by exact
 * `(file, schema, table)` — a ratchet, not a suppression: remove an entry
 * as its call site is migrated, and the guard immediately starts enforcing
 * it. Adding a *new* violation for an already-allowlisted schema in the
 * same file with a *different* table is NOT covered by an existing entry
 * (it's a distinct key) and still fails the build.
 *
 * ## Sonar-clean notes
 *
 * - No PATH-spawn (S4036). This guard only reads files; it never shells out.
 *
 * ## Usage
 *
 * `node scripts/ci-guard-cross-schema-reads.mjs`
 * `node scripts/ci-guard-cross-schema-reads.mjs --list`  — print every
 *   currently-detected violation as JSON (ignoring the allowlist) and exit
 *   0. Used to regenerate the allowlist after a migration; never wired into
 *   CI.
 *
 * Env overrides (for tests):
 *   - `CI_GUARD_WORKDIR` — repo root (default: two levels up from this file)
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.CI_GUARD_WORKDIR
  ? resolve(process.env.CI_GUARD_WORKDIR)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APPS_DIR = join(ROOT, 'apps');
const OWNERSHIP_PATH = join(ROOT, 'migrations', 'ownership.json');
const ALLOWLIST_PATH = join(ROOT, 'migrations', 'cross-schema-allowlist.json');

const EXEMPT_APPS = new Set(['kernel']);
const SCAN_EXTENSIONS = new Set(['.ts', '.tsx']);
const EXCLUDED_DIR_NAMES = new Set(['node_modules', '.next', 'dist', 'build', 'coverage', '__tests__', 'drizzle']);
const TEST_FILE_RE = /\.(test|spec)\.tsx?$/;

// ── ownership map ────────────────────────────────────────────────────────────

/** Flattens ownership.json's tables/views/types/functions buckets into a `schema -> owner` map. */
function loadSchemaOwners() {
  if (!existsSync(OWNERSHIP_PATH)) {
    throw new Error(`${OWNERSHIP_PATH} does not exist.`);
  }
  const map = JSON.parse(readFileSync(OWNERSHIP_PATH, 'utf8'));
  const schemaOwners = new Map();
  for (const bucket of Object.values(map)) {
    if (!bucket || typeof bucket !== 'object') continue;
    for (const entry of Object.values(bucket)) {
      if (entry?.schema && entry?.owner) schemaOwners.set(entry.schema, entry.owner);
    }
  }
  return schemaOwners;
}

/** App directory names under `apps/` that are candidates to scan (everything except the exempt kernel). */
function listScannableApps() {
  return readdirSync(APPS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !EXEMPT_APPS.has(d.name))
    .map((d) => d.name);
}

// ── comment stripping (so a comment mentioning a schema name never flags) ───

/**
 * Strips `//` and `/* *\/` comments from TS/TSX source while passing
 * string/template literal contents through untouched, so an SQL string
 * inside a template literal is still scanned but a comment ABOUT one isn't.
 * Deliberately simple (no full tokenizer) — a heuristic guard over a
 * heuristic detector, matching the grep-based methodology this whole check
 * is modeled on.
 */
function stripJsComments(source) {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const two = source.slice(i, i + 2);

    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < source.length && source[j] !== ch) {
        if (source[j] === '\\') j += 1;
        j += 1;
      }
      j = Math.min(j + 1, source.length);
      out += source.slice(i, j);
      i = j;
      continue;
    }

    if (two === '//') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }

    if (two === '/*') {
      i += 2;
      while (i < source.length && source.slice(i, i + 2) !== '*/') {
        if (source[i] === '\n') out += '\n';
        i += 1;
      }
      i = Math.min(i + 2, source.length);
      continue;
    }

    out += ch;
    i += 1;
  }
  return out;
}

// ── detection ────────────────────────────────────────────────────────────────

const SQL_REF_RE = /\b(?:FROM|JOIN|INTO|UPDATE)\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\s*\.\s*"?([A-Za-z_][A-Za-z0-9_]*)"?/g;
const PG_SCHEMA_RE = /\bpgSchema\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\)/g;

/** Finds every `schema.table` reference following a SQL keyword. Returns `{ kind: 'sql', schema, table }[]`, lowercased. */
function findSqlRefs(text) {
  const refs = [];
  SQL_REF_RE.lastIndex = 0;
  let m = SQL_REF_RE.exec(text);
  while (m !== null) {
    refs.push({ kind: 'sql', schema: m[1].toLowerCase(), table: m[2].toLowerCase() });
    m = SQL_REF_RE.exec(text);
  }
  return refs;
}

/** Finds every `pgSchema('name')` declaration. Returns `{ kind: 'pgSchema', schema, table: null }[]`, lowercased. */
function findPgSchemaRefs(text) {
  const refs = [];
  PG_SCHEMA_RE.lastIndex = 0;
  let m = PG_SCHEMA_RE.exec(text);
  while (m !== null) {
    refs.push({ kind: 'pgSchema', schema: m[1].toLowerCase(), table: null });
    m = PG_SCHEMA_RE.exec(text);
  }
  return refs;
}

/** Recursively lists every scannable TS/TSX source file under `dir`, skipping excluded directories/tests. */
function listSourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
      out.push(...listSourceFiles(join(dir, entry.name)));
      continue;
    }
    const ext = entry.name.slice(entry.name.lastIndexOf('.'));
    if (!SCAN_EXTENSIONS.has(ext)) continue;
    if (TEST_FILE_RE.test(entry.name)) continue;
    out.push(join(dir, entry.name));
  }
  return out;
}

/** Scans one file for cross-schema references not owned by `appOwner`. Returns violation records. */
function scanFile(filePath, appOwner, schemaOwners) {
  const raw = readFileSync(filePath, 'utf8');
  const cleaned = stripJsComments(raw);
  const refs = [...findSqlRefs(cleaned), ...findPgSchemaRefs(cleaned)];

  const violations = [];
  const seen = new Set(); // dedupe repeated refs to the same (schema, table) within one file
  for (const ref of refs) {
    const owner = schemaOwners.get(ref.schema);
    if (!owner || owner === appOwner) continue; // unknown identifier, or legitimately this app's own schema

    const dedupeKey = `${ref.kind}:${ref.schema}.${ref.table ?? ''}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    violations.push({ file: relative(ROOT, filePath).split('\\').join('/'), kind: ref.kind, schema: ref.schema, table: ref.table, owner, appOwner });
  }
  return violations;
}

/** Scans every non-exempt app for cross-schema violations. */
function scanRepo() {
  const schemaOwners = loadSchemaOwners();
  const violations = [];

  for (const appOwner of listScannableApps()) {
    const appDir = join(APPS_DIR, appOwner);
    if (!statSync(appDir).isDirectory()) continue;
    for (const filePath of listSourceFiles(appDir)) {
      violations.push(...scanFile(filePath, appOwner, schemaOwners));
    }
  }

  violations.sort((a, b) => a.file.localeCompare(b.file) || a.schema.localeCompare(b.schema) || (a.table ?? '').localeCompare(b.table ?? ''));
  return violations;
}

// ── allowlist ────────────────────────────────────────────────────────────────

/** Builds the allowlist lookup key for a violation — table is `''` for a schema-level (pgSchema) entry, matching the JSON file's convention. */
function allowlistKey(v) {
  return `${v.file}::${v.schema}::${v.table ?? ''}`;
}

function loadAllowlist() {
  if (!existsSync(ALLOWLIST_PATH)) return new Set();
  const parsed = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'));
  const entries = Array.isArray(parsed) ? parsed : parsed.violations;
  return new Set((entries ?? []).map((e) => `${e.file}::${e.schema}::${e.table ?? ''}`));
}

// ── main ─────────────────────────────────────────────────────────────────────

function reportViolations(violations) {
  console.error(`\nFAIL: ${violations.length} cross-schema reference(s) found that are not in the allowlist:\n`);
  for (const v of violations) {
    const what = v.kind === 'pgSchema' ? `pgSchema("${v.schema}")` : `${v.schema}.${v.table}`;
    console.error(`  - ${v.file}: references ${what}, owned by "${v.owner}" (this app is "${v.appOwner}")`);
  }
  console.error(
    '\nCross-schema reads/writes are a contract violation — go through the owning schema\'s ' +
      'kernel API instead. If this is a pre-existing, already-tracked violation, add it to ' +
      'migrations/cross-schema-allowlist.json (see migrations/OWNERSHIP.md) rather than ' +
      'suppressing this check.',
  );
}

function main() {
  const args = process.argv.slice(2);

  let violations;
  try {
    violations = scanRepo();
  } catch (err) {
    console.error(`ci-guard-cross-schema-reads: ${err.message}`);
    process.exit(1);
    return;
  }

  if (args.includes('--list')) {
    console.log(JSON.stringify(violations, null, 2));
    process.exit(0);
    return;
  }

  const allowlist = loadAllowlist();
  const newViolations = violations.filter((v) => !allowlist.has(allowlistKey(v)));

  if (newViolations.length > 0) {
    reportViolations(newViolations);
    process.exit(1);
    return;
  }

  console.log(`PASS: no new cross-schema violations found (${violations.length} allowlisted).`);
  process.exit(0);
}

main();
