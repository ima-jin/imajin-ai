import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanRepo, scanSource } from '../ci-guard-no-issue-refs-in-copy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const script = join(root, 'scripts/ci-guard-no-issue-refs-in-copy.mjs');

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'copy-guard-'));
  for (const [name, source] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source);
  }
  return dir;
}

describe('product-copy AST guard', () => {
  it.each([
    '<span>see #1234</span>',
    '<span>see imajin-ai#12</span>',
    '<span>{"see #12345"}</span>',
    '<span>{`see ${name} #1234`}</span>',
    '<span>see [#1234]</span>',
    ...['title', 'aria-label', 'placeholder', 'alt', 'label'].map(attr => `<input ${attr}="see #1234" />`),
    ...['description', 'label', 'title', 'message', 'error', 'reason'].map(field => `const copy = { ${field}: "see #1234" };`),
    'const description = "see #1234";',
    'let title; title = "see #1234";',
    'copy["label"] = "see #1234";',
    'const copy = { "description": `See ${name} #1234` };',
    'const copy = { reason: "see " + "#1234" };',
    'NextResponse.json({ nested: { detail: "see #1234" } });',
    'throw new Error("see #1234");',
  ])('rejects copy sink: %s', source => {
    expect(scanSource(source)).not.toHaveLength(0);
  });

  it.each([
    '// see #1234\nconst copy = { title: "Safe" };',
    '/* description: "see #1234" */',
    '<span>{/* see #1234 */}Safe</span>',
    'const color = "#333";',
    '<span className="bg-[#111] text-[#123456]">Safe</span>',
    '<span className={"bg-[#111]"}>Safe</span>',
    '<span style={{ color: "#333", background: "#123456" }}>Safe</span>',
    'const copy = { title: "Color #abcdef" };',
    'const copy = { "#1234": "not a copy property" };',
    'console.info("Internal history #1234");',
    'const internal = "see #1234";',
    'const copy = { title: "see #1234" }; // copy-allow-issue-ref: explicit operator reference',
    'const view = <span>see #1234</span>; // copy-allow-issue-ref: operator reference',
  ])('allows non-copy/color/comment or same-line exception: %s', source => {
    expect(scanSource(source)).toEqual([]);
  });

  it.each([
    'const title = "see #1234"; // copy-allow-issue-ref:',
    'const title = "see #1234"; // copy-allow-issue-ref:   ',
    '// copy-allow-issue-ref: previous line is not an exemption\nconst title = "see #1234";',
    'const title = "see #1234"; /* copy-allow-issue-ref: not a line comment */',
    'const title = "see #1234 // copy-allow-issue-ref: not a comment";',
  ])('refuses invalid or misplaced suppression: %s', source => {
    expect(scanSource(source)).toHaveLength(1);
  });

  it('does not exempt other lines of a multiline literal', () => {
    const source = 'const title = `see #1234\nsee #5678`; // copy-allow-issue-ref: only this line';
    expect(scanSource(source)).toEqual([{ file: 'fixture.tsx', line: 1, text: 'see #1234' }]);
  });

  it('excludes comments, tests, api specs, migrations and build output from repository scans', () => {
    const dir = fixture(Object.fromEntries([
      'apps/kernel/__tests__/fixture.tsx', 'apps/kernel/view.test.tsx',
      'apps/kernel/view.spec.jsx', 'packages/x/tests/fixture.tsx',
      'apps/kernel/api-spec/example.tsx', 'apps/kernel/migrations/example.tsx',
      'apps/kernel/dist/example.tsx', 'apps/kernel/node_modules/example.tsx',
      'apps/kernel/example.md', 'apps/kernel/api-spec/example.yaml',
    ].map(file => [file, '<span>see #1234</span>'])));
    expect(scanRepo(dir)).toEqual([]);
  });

  it('limits file exemptions to explicit MCP tool files with a reason', () => {
    const tool = 'apps/kernel/src/lib/mcp/tools/operator.ts';
    const dir = fixture({
      [tool]: 'const description = "Operator issue #1234";',
      'scripts/copy-issue-ref-allowlist.json': JSON.stringify([{ file: tool, reason: 'Agent-only operator tool' }]),
    });
    expect(scanRepo(dir)).toEqual([]);
  });

  it.each([
    [{ file: 'apps/kernel/app/jin/page.tsx', reason: 'Not an MCP tool' }],
    [{ file: 'apps/kernel/src/lib/mcp/tools/*.ts', reason: 'No glob exemptions' }],
    [{ file: 'apps/kernel/src/lib/mcp/tools/operator.ts', reason: '' }],
    [{ file: 'apps/kernel/src/lib/mcp/tools/operator.ts' }],
  ])('fails closed on invalid allowlist entries: %j', entry => {
    const dir = fixture({ 'scripts/copy-issue-ref-allowlist.json': JSON.stringify([entry]) });
    expect(() => scanRepo(dir)).toThrow(/exact MCP tool file and a non-empty reason/);
  });

  it('makes the real CLI fail a JSX leak and pass only a reasoned same-line exception', () => {
    const dir = fixture({ 'apps/kernel/view.tsx': '<span>see #1234</span>' });
    const run = () => spawnSync(process.execPath, [script], {
      env: { ...process.env, CI_GUARD_WORKDIR: dir }, encoding: 'utf8',
    });
    const failed = run();
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain('apps/kernel/view.tsx:1');
    writeFileSync(join(dir, 'apps/kernel/view.tsx'),
      'const view = <span>see #1234</span>; // copy-allow-issue-ref: explicit operator reference');
    expect(run().status).toBe(0);
  });

  it('keeps the actual product sources clean and the required CI job wired', () => {
    expect(scanRepo(root)).toEqual([]);
    expect(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8'))
      .toContain('run: node scripts/ci-guard-no-issue-refs-in-copy.mjs');
  });
});
