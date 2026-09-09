/**
 * Guard test (#1992/#1983): `packages/auth` is the published `@imajin/auth`
 * SDK and must never reach the kernel's database directly. Every kernel
 * table read/write belongs behind a kernel-internal HTTP route
 * (`postInternal()`, the profile service's batched `/api/resolve`, ...),
 * never a `@imajin/db` import or a hand-rolled raw SQL query baked into
 * this shared package — that coupling is exactly what dragged the kernel
 * database into every app that imports `@imajin/auth` (#1983 audit).
 *
 * Source-scan style mirrors the repo's root `scripts/ci-guard-*.mjs`
 * workflow guards (read every candidate file, regex-scan for a banned
 * pattern, collect every violation before failing) adapted into a vitest
 * test so it runs with `pnpm test` like every other package test, rather
 * than as a separate CI step.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

interface BannedPattern {
  name: string;
  regex: RegExp;
}

/**
 * Each pattern targets a distinct way this package could reach the
 * database again: the shared client package, the underlying `postgres`
 * driver, a DB-connected drizzle adapter, or a raw SQL tagged template
 * (this package's own historical `getClient()` convention — see git
 * history on `src/credentials.ts` before #1992). Deliberately does NOT
 * flag a bare `drizzle-orm` import: `src/resolve.ts`'s `createDbResolver`
 * takes a caller-supplied `db`/table via dependency injection and never
 * imports `@imajin/db` or connects to anything itself.
 */
const BANNED_PATTERNS: BannedPattern[] = [
  { name: '@imajin/db import (DB client)', regex: /from\s+['"]@imajin\/db['"]|require\(\s*['"]@imajin\/db['"]\s*\)/ },
  { name: 'getClient() call', regex: /\bgetClient\s*\(/ },
  { name: 'direct postgres driver import', regex: /from\s+['"]postgres['"]|require\(\s*['"]postgres['"]\s*\)/ },
  { name: 'DB-connected drizzle adapter import', regex: /from\s+['"]drizzle-orm\/(postgres-js|node-postgres)['"]/ },
  { name: 'raw SQL tagged template', regex: /\bsql\s*`/ },
];

function listTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...listTsFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      files.push(full);
    }
  }
  return files;
}

function violationsIn(content: string): string[] {
  return BANNED_PATTERNS.filter((p) => p.regex.test(content)).map((p) => p.name);
}

describe('packages/auth/src must not reach the database (#1992)', () => {
  const files = listTsFiles(SRC_DIR);

  it('scans a non-trivial number of source files (sanity-checks the scan itself runs)', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(files)('%s has no banned DB-access pattern', (file) => {
    const content = readFileSync(file, 'utf-8');
    expect(violationsIn(content), relative(SRC_DIR, file)).toEqual([]);
  });
});

interface SanityCase {
  label: string;
  source: string;
  shouldFlag: boolean;
}

/**
 * One row per banned pattern (positive control: `shouldFlag: true`) plus the
 * two legitimate DB-adjacent shapes this package actually uses and must NOT
 * flag (negative controls: `shouldFlag: false`) — collapsed into a single
 * `it.each` table rather than one `it()` per case to avoid the near-identical
 * `expect(violationsIn(...)).(not.)toEqual([])` block repeating per pattern.
 */
const SANITY_CASES: SanityCase[] = [
  { label: 'a @imajin/db import', source: "import { getClient } from '@imajin/db';", shouldFlag: true },
  { label: 'a getClient() call', source: 'const sql = getClient();', shouldFlag: true },
  { label: 'a raw SQL tagged template', source: 'const rows = await sql`SELECT * FROM auth.credentials`;', shouldFlag: true },
  { label: 'a direct postgres driver import', source: "import postgres from 'postgres';", shouldFlag: true },
  { label: 'a DB-connected drizzle adapter import', source: "import { drizzle } from 'drizzle-orm/postgres-js';", shouldFlag: true },
  {
    label: 'drizzle-orm query-builder usage via dependency injection (resolve.ts pattern)',
    source: "const { eq } = await import('drizzle-orm');\nexport function createDbResolver(db, table) {}",
    shouldFlag: false,
  },
  {
    label: "postInternal()-based HTTP calls (this package's actual DB-access replacement)",
    source: "import { postInternal } from './internal-post';\nawait postInternal('/api/credentials/resolve', { did });",
    shouldFlag: false,
  },
];

describe('BANNED_PATTERNS sanity checks (proves the scan is not vacuous)', () => {
  it.each(SANITY_CASES)('$label -> flagged: $shouldFlag', ({ source, shouldFlag }) => {
    expect(violationsIn(source).length > 0).toBe(shouldFlag);
  });
});
