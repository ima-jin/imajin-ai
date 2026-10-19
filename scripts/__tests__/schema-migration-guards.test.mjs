import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = fileURLToPath(new URL('../../.husky/pre-commit', import.meta.url));
const SYNC = fileURLToPath(new URL('../check-schema-migration-sync.sh', import.meta.url));
const GIT = ['/usr/bin/git', '/usr/local/bin/git', '/bin/git'].find(existsSync);
const BASH = ['/bin/bash', '/usr/bin/bash'].find(existsSync);
const SCHEMA = 'apps/kernel/src/db/schemas/usage.ts';

function repoWithStagedFiles(paths) {
  const dir = mkdtempSync(join(tmpdir(), 'schema-guard-'));
  execFileSync(GIT, ['init', '-q'], { cwd: dir });
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'migrations'), { recursive: true });
  // This fixture tests only the schema gate, not migration numbering validation.
  writeFileSync(join(dir, 'scripts/check-migrations.sh'), '#!/bin/bash\nexit 0\n');
  writeFileSync(join(dir, 'migrations/0001_baseline.sql'), '-- baseline\n');
  for (const path of paths) {
    const file = join(dir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '// fixture\n');
  }
  execFileSync(GIT, ['add', '--', ...paths], { cwd: dir });
  return dir;
}

describe.skipIf(!GIT || !BASH)('schema/migration precommit and branch-range guards', () => {
  it('keeps both schema patterns aligned, including split schemas but excluding their tests', () => {
    const hookPattern = readFileSync(HOOK, 'utf8').match(/grep -E '([^']+)'/)[1];
    const syncPattern = readFileSync(SYNC, 'utf8').match(/SCHEMA_PATTERN='([^']+)'/)[1];
    expect(hookPattern).toBe(syncPattern);
    const pattern = new RegExp(syncPattern);
    for (const path of [SCHEMA, 'apps/kernel/src/db/schema.ts', 'packages/db/src/index.ts']) {
      expect(pattern.test(path)).toBe(true);
    }
    expect(pattern.test('apps/kernel/src/db/schemas/__tests__/usage-billed.test.ts')).toBe(false);
  });

  it('blocks a staged split-schema change without a newly staged migration', () => {
    const result = spawnSync(BASH, [HOOK], { cwd: repoWithStagedFiles([SCHEMA]), encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Staged schema change without a new migration file');
    expect(result.stdout).toContain(SCHEMA);
  });

  it('accepts a staged split-schema change together with a new numbered migration', () => {
    const result = spawnSync(BASH, [HOOK], {
      cwd: repoWithStagedFiles([SCHEMA, 'migrations/0002_usage.sql']), encoding: 'utf8',
    });
    expect(result.status).toBe(0);
  });

  it('does not require a migration for schema test-only edits', () => {
    const result = spawnSync(BASH, [HOOK], {
      cwd: repoWithStagedFiles(['apps/kernel/src/db/schemas/__tests__/usage-billed.test.ts']), encoding: 'utf8',
    });
    expect(result.status).toBe(0);
  });
});
