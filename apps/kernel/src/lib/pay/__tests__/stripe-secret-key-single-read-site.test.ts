/**
 * Retirement guard (#2794): no kernel production source may read an
 * ambient Stripe credential. Tests may use fake legacy env placeholders.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..', '..');
const SCAN_ROOTS = [
  join(REPO_ROOT, 'apps', 'kernel', 'src'),
  join(REPO_ROOT, 'apps', 'kernel', 'app'),
];
const EXCLUDED_DIR_NAMES = new Set(['node_modules', '.next', 'dist', 'build', 'coverage', '__tests__']);
const SCAN_EXTENSIONS = new Set(['.ts', '.tsx']);
const TEST_FILE_RE = /\.(test|spec)\.tsx?$/;
const READ_SITE_RE = /process\.env(?:\.STRIPE_(?:SECRET_KEY|PUBLISHABLE_KEY|WEBHOOK_SECRET)|\[['"]STRIPE_(?:SECRET_KEY|PUBLISHABLE_KEY|WEBHOOK_SECRET)['"]\])/;

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

describe('Stripe credential env retirement guard (#2794)', () => {
  it('sanity-checks the scan actually walks real files', () => {
    // Guards against this test silently passing forever if REPO_ROOT/SCAN_ROOTS
    // ever drift and stop resolving to the real apps/kernel checkout.
    expect(statSync(SCAN_ROOTS[0]).isDirectory()).toBe(true);
    expect(listSourceFiles(SCAN_ROOTS[0]).length).toBeGreaterThan(0);
  });

  it('has no ambient credential read sites in kernel production code', () => {
    const readSites = findReadSites();
    expect(readSites).toEqual([]);
  });
});
