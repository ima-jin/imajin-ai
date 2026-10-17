import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eventsWorkspaceReferences } from '../ci-guard-events-pruned.mjs';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(file, content) {
  const root = mkdtempSync(join(tmpdir(), 'events-pruned-'));
  roots.push(root);
  const path = join(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return root;
}

describe('events extraction regression guard (#2517)', () => {
  it('passes on the real pruned kernel checkout', () => {
    expect(eventsWorkspaceReferences(fileURLToPath(new URL('../..', import.meta.url)))).toEqual([]);
  });

  it('rejects a recreated app even without a workspace importer', () => {
    expect(eventsWorkspaceReferences(fixture('apps/events/package.json', '{}')))
      .toContain('apps/events still exists');
  });

  it.each([
    ['pnpm-lock.yaml', '  apps/events:\n'],
    ['pnpm-workspace.yaml', "  - 'apps/events'\n"],
    ['turbo.json', '{"tasks":{"@imajin/events#build":{}}}\n'],
    ['eslint.config.mjs', 'export default [{ ignores: ["apps/events/**"] }];\n'],
    ['package.json', '{"scripts":{"dev:events":"pnpm --filter @imajin/events dev"}}\n'],
    ['.github/workflows/build.yml', 'paths: [apps/events/**]\n'],
    ['deploy/ecosystem.dev.config.js', 'const app = { cwd: "/repo/apps/events" };\n'],
    ['scripts/build.sh', 'pnpm --filter @imajin/events build\n'],
    ['apps/kernel/package.json', '{"dependencies":{"@imajin/events":"workspace:*"}}\n'],
  ])('rejects executable references in %s', (file, content) => {
    expect(eventsWorkspaceReferences(fixture(file, content))).toEqual([`${file}:1`]);
  });

  it('preserves standalone routes, data ownership, comments and negative test fixtures', () => {
    const root = fixture('deploy/routes.js', '// apps/events was extracted\nconst route = "/events";\n');
    for (const [file, content] of [
      ['migrations/0001_seed.sql', 'CREATE SCHEMA events;'],
      ['scripts/__tests__/fixture.test.mjs', 'const removed = "apps/events";'],
      ['scripts/helper.test.sh', 'legacy=apps/events'],
    ]) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), content);
    }
    expect(eventsWorkspaceReferences(root)).toEqual([]);
  });
});
