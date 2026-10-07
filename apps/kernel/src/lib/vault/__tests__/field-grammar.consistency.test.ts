/**
 * Consistency test for the vault field-name grammar (#2699).
 *
 * `field-grammar.ts` is the ONE parser for namespaced field names. This test
 * reads the real source of every vault route / admin component / vault lib
 * module and fails when:
 *   1. a route that reads or writes a field name does not import the grammar, or
 *   2. any consumer parses a field name inline (`split(':')`, a
 *      `startsWith('<ns>:')` prefix check, a field-name regex).
 *
 * Source scanning (rather than mocking every route) is deliberate: the property
 * being pinned is structural — "no ad-hoc parsing left" — and a behavioural
 * test of one route cannot see a regex added to another.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const KERNEL_ROOT = join(__dirname, '..', '..', '..', '..');
const GRAMMAR_MODULE = '@/src/lib/vault/field-grammar';
const GRAMMAR_FILE = join('src', 'lib', 'vault', 'field-grammar.ts');

const ROUTE_ROOTS = [join('app', 'api', 'vault'), join('app', 'auth', 'api', 'vault')];
const CONSUMER_ROOTS = [...ROUTE_ROOTS, join('app', 'admin', 'vault'), join('src', 'lib', 'vault')];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      return entry === '__tests__' ? [] : walk(full);
    }
    return [full];
  });
}

function sourcesUnder(roots: string[], pattern: RegExp): { path: string; source: string }[] {
  return roots
    .flatMap((root) => walk(join(KERNEL_ROOT, root)))
    .filter((file) => pattern.test(file))
    .map((file) => ({ path: relative(KERNEL_ROOT, file).split(sep).join('/'), source: readFileSync(file, 'utf8') }));
}

/** Strip comments so prose that mentions `split(':')` is not mistaken for code. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const routes = sourcesUnder(ROUTE_ROOTS, /route\.ts$/);

/**
 * A route "reads or writes a field name" when it takes one from the body or
 * the URL: `{ field } = body`, `body.fields`, or a `[field]` route segment
 * (`params: Promise<{ field: string }>`). `.../fetch` and `.../ack` take a
 * grantId; their `field` is read from the stored grant, never from the caller.
 */
const TAKES_FIELD_NAME =
  /Promise<\{\s*field\b|\bbody\??\.fields?\b|\)\.fields\b|\{[^}]*\bfield\b[^}]*\}\s*=\s*body\b/;

/** The routes that must delegate — listed so a rename/removal is a conscious edit, not silent drift. */
const EXPECTED_FIELD_ROUTES = [
  'app/api/vault/delegation/grant/route.ts',
  'app/api/vault/delegation/revoke/route.ts',
  'app/api/vault/grantees/[field]/route.ts',
  'app/api/vault/history/[field]/route.ts',
  'app/api/vault/migrate-custody/route.ts',
  'app/api/vault/rotate/route.ts',
  'app/api/vault/rotation-sweep/route.ts',
  'app/api/vault/set/route.ts',
  'app/api/vault/upgrade-custody/route.ts',
];

describe('vault routes delegate field-name validation to the grammar', () => {
  const fieldRoutes = routes.filter((route) => TAKES_FIELD_NAME.test(stripComments(route.source)));

  it('discovers exactly the routes that take a field name', () => {
    expect(fieldRoutes.map((route) => route.path).sort((a, b) => a.localeCompare(b))).toEqual(EXPECTED_FIELD_ROUTES);
  });

  it.each(EXPECTED_FIELD_ROUTES)('%s imports and calls parseVaultFieldName', (path) => {
    const route = routes.find((candidate) => candidate.path === path);
    expect(route, `${path} must exist`).toBeDefined();
    const code = stripComments(route!.source);
    expect(code).toContain(`from '${GRAMMAR_MODULE}'`);
    expect(code).toMatch(/\bparseVaultFieldName\(/);
  });
});

describe('no consumer parses a vault field name inline', () => {
  const consumers = sourcesUnder(CONSUMER_ROOTS, /\.(ts|tsx)$/).filter((file) => file.path !== GRAMMAR_FILE.split(sep).join('/'));

  it('scans a non-trivial set of files', () => {
    expect(consumers.length).toBeGreaterThan(30);
    expect(consumers.some((file) => file.path === 'app/admin/vault/set-secret-dialog.tsx')).toBe(true);
  });

  const FORBIDDEN: [string, RegExp][] = [
    ["split(':')", /\.split\(\s*['"`]:['"`]\s*\)/],
    ["indexOf(':')", /\.indexOf\(\s*['"`]:['"`]\s*\)/],
    ["startsWith('<namespace>:')", /\.startsWith\(\s*['"`][\w.-]+:['"`]\s*\)/],
    ['startsWith(<NAMESPACE>_PREFIX)', /\.startsWith\(\s*\w*(?:FIELD_PREFIX|NAMESPACE_PREFIX)\s*\)/],
    ['a named field-name regex', /\b(?:FIELD_NAME_GRAMMAR|ENV_STYLE_FIELD|FIELD_NAME_RE\w*|FIELD_RE)\b/],
    ["a regex literal with ':' in a character class", /\/\^?\[[^\]/\n]*:[^\]/\n]*\][^/\n]*\/[a-z]*\s*\.test\(/],
  ];

  it.each(FORBIDDEN)('has no %s', (_label, pattern) => {
    const offenders = consumers.filter((file) => pattern.test(stripComments(file.source))).map((file) => file.path);
    expect(offenders).toEqual([]);
  });

  it('keeps the grammar module itself free of server-only imports (the admin dialog bundles it)', () => {
    const grammar = readFileSync(join(KERNEL_ROOT, GRAMMAR_FILE), 'utf8');
    expect(stripComments(grammar)).not.toMatch(/^\s*import\s/m);
  });
});
