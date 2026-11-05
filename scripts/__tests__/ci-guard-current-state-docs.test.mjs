import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  CONSUMER_FILES, HISTORY_RECORDS, ROUTE_BLOCK_THRESHOLD, scanDocument, scanRepo,
} from '../ci-guard-current-state-docs.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const script = join(root, 'scripts/ci-guard-current-state-docs.mjs');
const temporaryDirectories = [];
afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'consumer-docs-'));
  temporaryDirectories.push(dir);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

const routes = (count, shape = n => `- GET, OPTIONS /auth/api/example/${n} — apps/kernel/app/example/route.ts`) =>
  Array.from({ length: count }, (_, n) => shape(n)).join('\n');
const run = dir => spawnSync(process.execPath, [script], {
  encoding: 'utf8', env: { ...process.env, CI_GUARD_WORKDIR: dir },
});

describe('current-state consumer documentation guard', () => {
  it.each([
    '## v0.9.9 addendum', '# v12.123.456', '### Source ADDENDUM',
    '#### Contract delta', '###### Current v1.2.3 behavior',
    'Release v0.9.9\n---', 'Contract delta\n===', 'Source addendum\n---',
  ])('rejects history headings: %s', heading => {
    expect(scanDocument(heading)).toContainEqual(expect.objectContaining({ rule: 'history heading' }));
  });

  it.each([
    '# Current integration', 'A single GET /auth/api/example route in prose.',
    'See the [auth spec](https://jin.imajin.ai/auth/api/spec).',
    'The version field is a wire-format field, not release history.',
    '```md\n## Example addendum heading in a literal\n```',
    '~~~md\n## Example delta heading in a literal\n~~~',
    '### Deltastream is a name', '### v1.2 wire format',
  ])('allows concepts, links, single routes and literals: %s', content => {
    expect(scanDocument(content)).toEqual([]);
  });

  it.each([
    n => `- GET, OPTIONS /auth/api/${n} — source`,
    n => `GET /auth/api/${n}`,
    n => `| POST | /media/api/${n} | Description |`,
    n => `- \`GET\` \`/auth/api/${n}\``,
    n => `- /auth/api/${n} — source`,
    n => `1. DELETE https://node.example/auth/api/${n}`,
  ])('rejects inventories in list, table and raw forms', shape => {
    const block = routes(ROUTE_BLOCK_THRESHOLD, shape);
    expect(scanDocument(block)).toEqual([{ file: 'README.md', line: 1, rule: 'route inventory' }]);
    expect(scanDocument(`\`\`\`text\n${block}\n\`\`\``)[0].line).toBe(2);
    expect(scanDocument(routes(ROUTE_BLOCK_THRESHOLD - 1, shape))).toEqual([]);
  });

  it('reports one start per run and resets after prose or a blank line', () => {
    expect(scanDocument(routes(12))).toHaveLength(1);
    expect(scanDocument(`${routes(5)}\n\n${routes(5)}`)).toEqual([]);
    expect(scanDocument(`${routes(5)}\nIntegration explanation.\n${routes(5)}`)).toEqual([]);
    expect(scanDocument(`# Guide\r\n${routes(6).replaceAll('\n', '\r\n')}`)[0].line).toBe(2);
    expect(scanDocument(routes(6, n => `| GET /api/${n} | owner | irreversible | reason |`))).toEqual([]);
  });

  it.each(CONSUMER_FILES)('covers the explicit consumer path %s', file => {
    const dir = fixture({ [file]: '## v0.9.9 addendum' });
    expect(scanRepo(dir)).toEqual([{ file, line: 1, rule: 'history heading' }]);
  });

  it('covers nested docs, but exempts only the ten exact history records', () => {
    expect(HISTORY_RECORDS.size).toBe(10);
    const files = Object.fromEntries([...HISTORY_RECORDS].map(file => [file, '## v0.9.9 addendum']));
    files['docs/canon/rfcs/consumer-guide.md'] = routes(6);
    const dir = fixture(files);
    expect(scanRepo(dir)).toEqual([{ file: 'docs/canon/rfcs/consumer-guide.md', line: 1, rule: 'route inventory' }]);
  });

  it('does not scan CHANGELOG, GitHub metadata, numbered SQL or unrelated app docs', () => {
    const dir = fixture(Object.fromEntries([
      'CHANGELOG.md', '.github/README.md', 'migrations/9999_example.sql', 'apps/example/README.md',
    ].map(file => [file, '## v0.9.9 addendum'])));
    expect(scanRepo(dir)).toEqual([]);
    expect(scanRepo(join(dir, 'absent'))).toEqual([]);
  });

  it.each(['## v0.9.9 addendum', routes(6)])('makes the real CLI fail a planted violation, then pass a rewrite', content => {
    const dir = fixture({ 'README.md': content });
    const failed = run(dir);
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain('README.md:1:');
    writeFileSync(join(dir, 'README.md'), '# Guide\n\nUse the [auth spec](https://node.example/auth/api/spec).\n');
    expect(run(dir).status).toBe(0);
  });

  it('passes records through the real CLI and reports unreadable trees as failure', () => {
    expect(run(fixture(Object.fromEntries([...HISTORY_RECORDS].map(file => [file, '## Addendum'])))).status).toBe(0);
    const dir = fixture({ 'placeholder': '' });
    mkdirSync(join(dir, 'README.md'));
    const failed = run(dir);
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain('ci-guard-current-state-docs:');
  });

  it('is wired into the CI Guards job and the package check command', () => {
    const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
    const guards = ci.split('\n  ci-guards:')[1].split('\n  sonarcloud:')[0];
    expect(guards).toContain('run: node scripts/ci-guard-current-state-docs.mjs');
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(pkg.scripts['check:current-state-docs']).toBe('node scripts/ci-guard-current-state-docs.mjs');
  });

  it.each(['llms.txt', 'llms-full.txt'])('%s is concept-first, compact and links every defined service spec', name => {
    const text = readFileSync(join(root, 'apps/kernel/public', name), 'utf8');
    expect(text).toMatch(/^# Imajin\n\n> [^\n]+\n/);
    for (const heading of ['What Imajin is', 'Key concepts', 'How to integrate', 'Service specifications', 'Further reading']) {
      expect(text).toContain(`## ${heading}`);
    }
    expect(text).not.toMatch(/\bv\d+\.\d+(?:\.\d+)?\b|(?:issues|pull)\/\d+|#\d{3,}/);
    expect(scanDocument(text)).toEqual([]);
    expect(Buffer.byteLength(text)).toBeLessThan(40_000);
    if (name === 'llms.txt') expect(text.trimEnd().split('\n').length).toBeLessThanOrEqual(150);
    for (const file of readdirSync(join(root, 'apps/kernel/api-spec')).filter(file => file.endsWith('.yaml'))) {
      expect(text).toContain(`https://jin.imajin.ai/${file.slice(0, -5)}/api/spec`);
    }
  });
});
