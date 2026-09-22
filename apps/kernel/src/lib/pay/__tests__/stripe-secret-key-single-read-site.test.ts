/**
 * Grep guard (#2174): `STRIPE_SECRET_KEY` must be read from `process.env`
 * in exactly one source file within the pay subsystem — the adapter's
 * client factory (`providers/stripe-client.ts`). Every other call site
 * (webhook routes, `StripeProvider`, `refund.ts`, etc.) must go through
 * `getStripeClient()` / `isStripeConfigured()` instead of reading the raw
 * env var a second time.
 *
 * Scans the same roots as `scripts/ci-guard-stripe-import-scope.mjs`
 * (`lib/pay/` and `app/pay/`) so this guard's scope matches the sibling
 * guard's — a file outside those roots (e.g. `.well-known/agent.json`'s
 * unrelated capability probe) is a different concern and out of scope here.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..', '..');
const SCAN_ROOTS = [
  join(REPO_ROOT, 'apps', 'kernel', 'src', 'lib', 'pay'),
  join(REPO_ROOT, 'apps', 'kernel', 'app', 'pay'),
];
const EXCLUDED_DIR_NAMES = new Set(['node_modules', '.next', 'dist', 'build', 'coverage', '__tests__']);
const SCAN_EXTENSIONS = new Set(['.ts', '.tsx']);
const TEST_FILE_RE = /\.(test|spec)\.tsx?$/;
const READ_SITE_RE = /process\.env\.STRIPE_SECRET_KEY/;

const ADAPTER_FILE = join('apps', 'kernel', 'src', 'lib', 'pay', 'providers', 'stripe-client.ts');

function listSourceFiles(dir: string): string[] {
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
      out.push(...listSourceFiles(full));
      continue;
    }
    if (!SCAN_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf('.')))) continue;
    if (TEST_FILE_RE.test(entry.name)) continue;
    out.push(full);
  }
  return out;
}

function findReadSites(): string[] {
  const hits: string[] = [];
  for (const root of SCAN_ROOTS) {
    for (const file of listSourceFiles(root)) {
      const source = readFileSync(file, 'utf8');
      if (READ_SITE_RE.test(source)) {
        hits.push(relative(REPO_ROOT, file).replaceAll('\\', '/'));
      }
    }
  }
  return hits.sort();
}

describe('STRIPE_SECRET_KEY single-read-site guard (#2174)', () => {
  it('sanity-checks the scan actually walks real files', () => {
    // Guards against this test silently passing forever if REPO_ROOT/SCAN_ROOTS
    // ever drift and stop resolving to the real apps/kernel checkout.
    expect(statSync(SCAN_ROOTS[0]).isDirectory()).toBe(true);
    expect(listSourceFiles(SCAN_ROOTS[0]).length).toBeGreaterThan(0);
  });

  it('is read from process.env in exactly one file: the adapter client factory', () => {
    const readSites = findReadSites();
    expect(readSites).toEqual([ADAPTER_FILE.replaceAll('\\', '/')]);
  });
});
