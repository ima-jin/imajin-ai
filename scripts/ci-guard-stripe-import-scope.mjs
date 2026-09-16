#!/usr/bin/env node
/**
 * Stripe import scope guard (#2172 design amendment, point 2).
 *
 * ## Why this exists
 *
 * The `WithdrawRail` adapter interface (`apps/kernel/src/lib/pay/rails/`)
 * exists specifically so the withdraw/reconciliation code path never knows
 * Stripe exists — every rail-specific detail lives behind the interface,
 * in an adapter under `apps/kernel/src/lib/pay/providers/`. This guard is
 * what turns "someone imported `stripe` directly in a new file under
 * `lib/pay/` or `app/pay/`" into a CI failure instead of a slow regression
 * back toward the tight coupling the amendment's review comment
 * ("is this going to tightly couple Stripe to the kernel?") called out.
 *
 * ## What it checks
 *
 * Every `.ts`/`.tsx` source file (tests excluded) under
 * `apps/kernel/src/lib/pay/` and `apps/kernel/app/pay/` for a static
 * `import ... from 'stripe'` or `require('stripe')` — EXCEPT files whose
 * path contains a `providers/` segment, which is where every rail
 * adapter's Stripe SDK usage is expected to live.
 *
 * ## Allowlist
 *
 * Introduced with real, pre-existing violations still in the tree (the
 * withdraw route's private Stripe client — deleted by #2172 itself — the
 * shared `getStripe()` singleton, the webhook route/handlers, and the
 * Connect webhook route). Same ratchet convention as
 * `scripts/ci-guard-cross-schema-reads.mjs` /
 * `migrations/cross-schema-allowlist.json`: `scripts/stripe-import-allowlist.json`
 * only ever shrinks as each call site migrates its Stripe usage behind a
 * `WithdrawRail`-style adapter.
 *
 * ## Sonar-clean notes
 *
 * - No PATH-spawn (S4036). This guard only reads files; it never shells out.
 *
 * ## Usage
 *
 * `node scripts/ci-guard-stripe-import-scope.mjs`
 * `node scripts/ci-guard-stripe-import-scope.mjs --list` — print every
 *   currently-detected violation as JSON (ignoring the allowlist) and exit
 *   0. Used to regenerate the allowlist; never wired into CI.
 *
 * Env overrides (for tests):
 *   - `CI_GUARD_WORKDIR` — repo root (default: two levels up from this file)
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.CI_GUARD_WORKDIR
  ? resolve(process.env.CI_GUARD_WORKDIR)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWLIST_PATH = join(ROOT, 'scripts', 'stripe-import-allowlist.json');

const SCAN_ROOTS = [
  join('apps', 'kernel', 'src', 'lib', 'pay'),
  join('apps', 'kernel', 'app', 'pay'),
];
const SCAN_EXTENSIONS = new Set(['.ts', '.tsx']);
const EXCLUDED_DIR_NAMES = new Set(['node_modules', '.next', 'dist', 'build', 'coverage', '__tests__']);
const TEST_FILE_RE = /\.(test|spec)\.tsx?$/;
const EXEMPT_DIR_SEGMENT = 'providers';

// Deliberately simple, single-purpose checks rather than one compound
// alternation regex (#2172 review: the earlier combined pattern tripped
// Sonar's regex-complexity/super-linear-backtracking rules S8786/S5843).
// Every real `import ... from 'stripe'` / `require('stripe')` in this
// codebase is a single line (see `stripComments` below — matching never
// needs to cross a newline), so per-line string/regex checks are both
// simpler and no less accurate than one cross-line regex.
const IMPORT_LINE_RE = /^\s*import\b/;
const REQUIRE_STRIPE_RE = /\brequire\(\s*['"]stripe['"]\s*\)/;
const FROM_STRIPE_SINGLE_QUOTE = "from 'stripe'";
const FROM_STRIPE_DOUBLE_QUOTE = 'from "stripe"';

/** True when a single line of source is an `import` statement pulling from 'stripe', or a `require('stripe')` call. */
function lineImportsStripe(line) {
  if (IMPORT_LINE_RE.test(line) && (line.includes(FROM_STRIPE_SINGLE_QUOTE) || line.includes(FROM_STRIPE_DOUBLE_QUOTE))) {
    return true;
  }
  return REQUIRE_STRIPE_RE.test(line);
}

/** True when any line of `source` imports the `stripe` package. */
function sourceImportsStripe(source) {
  return source.split('\n').some(lineImportsStripe);
}

/**
 * Strips `//` line comments and `/* *\/` block comments from source text
 * (a heuristic, not a full tokenizer — same methodology
 * `ci-guard-cross-schema-reads.mjs` uses) so a comment or string literal
 * that merely MENTIONS `from 'stripe'` (e.g. explaining a past import)
 * never flags. Deliberately does not special-case string literals
 * containing `//` or `/*`, since a real `import`/`require` statement never
 * appears inside a string in valid TS.
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (match) =>
    match.startsWith('/*') ? match.replace(/[^\n]/g, ' ') : '',
  );
}

/** Recursively lists every scannable TS/TSX source file under `dir`, skipping excluded directories/tests. */
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

/** True when `relPath` (repo-relative, forward-slashed) has a `providers/` path segment. */
function isUnderProviders(relPath) {
  return relPath.split('/').includes(EXEMPT_DIR_SEGMENT);
}

function scanFile(filePath) {
  const relPath = relative(ROOT, filePath).replaceAll('\\', '/');
  if (isUnderProviders(relPath)) return null;

  const source = stripComments(readFileSync(filePath, 'utf8'));
  if (!sourceImportsStripe(source)) return null;

  return { file: relPath };
}

function scanRepo() {
  const violations = [];
  for (const scanRoot of SCAN_ROOTS) {
    for (const filePath of listSourceFiles(join(ROOT, scanRoot))) {
      const violation = scanFile(filePath);
      if (violation) violations.push(violation);
    }
  }
  violations.sort((a, b) => a.file.localeCompare(b.file));
  return violations;
}

function loadAllowlist() {
  if (!existsSync(ALLOWLIST_PATH)) return new Set();
  const parsed = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'));
  const entries = Array.isArray(parsed) ? parsed : parsed.violations;
  return new Set((entries ?? []).map((e) => e.file));
}

function reportViolations(violations) {
  console.error(`\nFAIL: ${violations.length} 'stripe' import(s) found outside lib/pay/providers/ that are not in the allowlist:\n`);
  for (const v of violations) {
    console.error(`  - ${v.file}`);
  }
  console.error(
    "\nThe stripe SDK may only be imported under apps/kernel/src/lib/pay/providers/ — implement rail-specific logic " +
      "behind a WithdrawRail adapter there instead. If this is a pre-existing, already-tracked violation, add it to " +
      'scripts/stripe-import-allowlist.json rather than suppressing this check.',
  );
}

function main() {
  const args = process.argv.slice(2);

  let violations;
  try {
    violations = scanRepo();
  } catch (err) {
    console.error(`ci-guard-stripe-import-scope: ${err.message}`);
    process.exit(1);
    return;
  }

  if (args.includes('--list')) {
    console.log(JSON.stringify(violations, null, 2));
    process.exit(0);
    return;
  }

  const allowlist = loadAllowlist();
  const newViolations = violations.filter((v) => !allowlist.has(v.file));

  if (newViolations.length > 0) {
    reportViolations(newViolations);
    process.exit(1);
    return;
  }

  console.log(`PASS: no new stripe-import-scope violations found (${violations.length} allowlisted).`);
  process.exit(0);
}

main();
