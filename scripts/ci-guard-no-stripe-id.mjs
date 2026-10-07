#!/usr/bin/env node
/**
 * `stripe_id` re-introduction guard (#2650, step 5 of the #2173 pay-rail boundary).
 *
 * ## Why this exists
 *
 * The pay ledger carries no Stripe-named columns: `pay.transactions.stripe_id`
 * was dropped by migration 0181 in favour of the rail-generic
 * `rail` + `external_ref` pair (#2176). Nothing in the type system stops a
 * future change from re-adding a `stripe_id` column, or a reader/writer that
 * assumes one — a raw-SQL string (like the events sales join did) would only
 * fail at runtime in prod. This guard turns that into a CI failure.
 *
 * ## What it checks
 *
 * Every non-test source file under `apps/` and `packages/` (`.ts`, `.tsx`,
 * `.js`, `.jsx`, `.mjs`, `.cjs`) for the identifiers `stripe_id` or
 * `stripeId`, after stripping comments (so prose explaining the history never
 * flags). Matching is whole-identifier: `stripeIdx`, `checkoutStripeId` and
 * `stripe_identity` do not match, `tx_stripe_id` does.
 *
 * Migrations live outside `apps/`/`packages/` and are never scanned — the
 * 0001 seed and 0181 legitimately name the column.
 *
 * ## Allowlist
 *
 * `scripts/stripe-id-allowlist.json` lists files that may keep the name for a
 * reason other than the ledger column. Today that is exactly one entry: the
 * PUBLIC `stripe_id` field of the transactions API response, which the ruling
 * keeps for one more release (fed from `external_ref`). Same ratchet
 * convention as `scripts/stripe-import-allowlist.json`: it only ever shrinks.
 *
 * ## Sonar-clean notes
 *
 * - No PATH-spawn (S4036). This guard only reads files; it never shells out.
 *
 * ## Usage
 *
 * `node scripts/ci-guard-no-stripe-id.mjs`
 * `node scripts/ci-guard-no-stripe-id.mjs --list` — print every detected
 *   reference as JSON (ignoring the allowlist) and exit 0.
 *
 * Env overrides (for tests):
 *   - `CI_GUARD_WORKDIR` — repo root (default: one level up from this file's dir)
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.CI_GUARD_WORKDIR
  ? resolve(process.env.CI_GUARD_WORKDIR)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWLIST_PATH = join(ROOT, 'scripts', 'stripe-id-allowlist.json');

const SCAN_ROOTS = ['apps', 'packages'];
const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const EXCLUDED_DIR_NAMES = new Set(['node_modules', '.next', '.turbo', 'dist', 'build', 'coverage', '__tests__']);
const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;

// Whole-identifier match: not preceded or followed by a letter/digit.
// (`_` is deliberately NOT a boundary so `tx_stripe_id` still matches.)
const FORBIDDEN_NAMES = ['stripe_id', 'stripeId'];
const IDENTIFIER_CHAR_RE = /[A-Za-z0-9]/;

/** Strips `//` and block comments, preserving newlines so line numbers stay accurate. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (match) =>
    match.startsWith('/*') ? match.replace(/[^\n]/g, ' ') : '',
  );
}

/** True when `name` occurs in `line` as a whole identifier (see FORBIDDEN_NAMES note). */
function lineHasIdentifier(line, name) {
  let from = 0;
  for (;;) {
    const at = line.indexOf(name, from);
    if (at === -1) return false;
    const before = at === 0 ? '' : line[at - 1];
    const after = line[at + name.length] ?? '';
    if (!IDENTIFIER_CHAR_RE.test(before) && !IDENTIFIER_CHAR_RE.test(after)) return true;
    from = at + 1;
  }
}

/** Recursively lists every scannable source file under `dir`, skipping excluded directories/tests. */
function listSourceFiles(dir) {
  if (!existsSync(dir)) return [];
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

/** Every `{ file, line, name }` hit in one file, comments excluded. */
function scanFile(filePath) {
  const relPath = relative(ROOT, filePath).replaceAll('\\', '/');
  const hits = [];
  const lines = stripComments(readFileSync(filePath, 'utf8')).split('\n');
  lines.forEach((line, index) => {
    for (const name of FORBIDDEN_NAMES) {
      if (lineHasIdentifier(line, name)) hits.push({ file: relPath, line: index + 1, name });
    }
  });
  return hits;
}

function scanRepo() {
  const hits = [];
  for (const scanRoot of SCAN_ROOTS) {
    for (const filePath of listSourceFiles(join(ROOT, scanRoot))) {
      hits.push(...scanFile(filePath));
    }
  }
  hits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return hits;
}

function loadAllowlist() {
  if (!existsSync(ALLOWLIST_PATH)) return new Set();
  const parsed = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'));
  const entries = Array.isArray(parsed) ? parsed : parsed.violations;
  return new Set((entries ?? []).map((e) => e.file));
}

function reportViolations(violations) {
  console.error(`\nFAIL: ${violations.length} reference(s) to the dropped pay.transactions.stripe_id column found:\n`);
  for (const v of violations) {
    console.error(`  - ${v.file}:${v.line} (${v.name})`);
  }
  console.error(
    '\npay.transactions has no Stripe-named columns (#2650, migration 0181). Read and write the rail-generic ' +
      "`rail` + `external_ref` columns instead (apps/kernel/src/lib/pay/external-ref.ts: `externalRefColumns` / " +
      '`whereExternalRef`). If a file legitimately needs the name for another reason (e.g. the deprecated public ' +
      'API field), add it to scripts/stripe-id-allowlist.json with sign-off rather than suppressing this check.',
  );
}

function main() {
  const args = process.argv.slice(2);

  let hits;
  try {
    hits = scanRepo();
  } catch (err) {
    console.error(`ci-guard-no-stripe-id: ${err.message}`);
    process.exit(1);
    return;
  }

  if (args.includes('--list')) {
    console.log(JSON.stringify(hits, null, 2));
    process.exit(0);
    return;
  }

  const allowlist = loadAllowlist();
  const violations = hits.filter((h) => !allowlist.has(h.file));

  if (violations.length > 0) {
    reportViolations(violations);
    process.exit(1);
    return;
  }

  console.log(`PASS: no stripe_id references found (${hits.length} allowlisted).`);
  process.exit(0);
}

main();
