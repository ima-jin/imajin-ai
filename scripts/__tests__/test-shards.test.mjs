import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { databaseTestFiles, isDatabaseTest } from '../test-projects.mjs';
import workspace from '../../vitest.workspace';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path) => readFileSync(join(root, path), 'utf8');
const ci = YAML.parse(read('.github/workflows/ci.yml'));
const shards = ci.jobs['test-shards'];
const aggregate = ci.jobs.test;

describe('required Test check', () => {
  it('runs four shards without cancelling siblings on failure', () => {
    expect(shards.strategy).toEqual({ 'fail-fast': false, matrix: { shard: [1, 2, 3, 4] } });
    expect(aggregate.name).toBe('Test');
    expect(aggregate.needs).toEqual(['test-shards']);
    expect(aggregate.if).toBe('always()');
    expect(ci.jobs.build.needs).toContain('test');
    expect(ci.jobs.sonarcloud.needs).toContain('test');
  });

  it('does not let other jobs starve a shard or the aggregate of runner slots', () => {
    expect(shards.needs).toBeUndefined();
    for (const [name, job] of Object.entries(ci.jobs)) {
      if (['test-shards', 'test'].includes(name)) continue;
      expect(job.needs, name).toContain('test');
    }
  });

  it.each(['success', 'failure', 'cancelled', 'skipped', ''])(
    'only succeeds when the shard result is success (%s)', (result) => {
      const gate = aggregate.steps[0];
      expect(gate.env.SHARD_RESULT).toBe('${{ needs.test-shards.result }}');
      const shell = process.platform === 'win32'
        ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
      const child = spawnSync(shell, ['-c', gate.run], {
        env: { ...process.env, SHARD_RESULT: result }, encoding: 'utf8',
      });
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(result === 'success' ? 0 : 1);
    },
  );

  it('shards the affected selection, not the full suite, in the merge queue', () => {
    const affected = shards.steps.find((step) => step.name === 'Run affected unit tests (merge group)');
    expect(affected.if).toBe("github.event_name == 'merge_group'");
    expect(affected.run).toContain('bash scripts/ci/merge-group-tests.sh --shard=${{ matrix.shard }}/4');
    const script = read('scripts/ci/merge-group-tests.sh');
    expect(script).toContain('--filter="...[$BASE_SHA]"');
    expect(script).toContain('test:agent "${FILTERS[@]}" "$@" --passWithNoTests');
    expect(script).toContain('vitest.workspace.ts');
    expect(script).toContain('--exclude \'**/e2e/**\'');
    expect(script).toContain('No affected unit-test directories.');
  });

  it('merges exactly four native coverage reports into the unchanged Sonar artifact', () => {
    const run = shards.steps.find((step) => step.name === 'Run tests with coverage');
    expect(run.run).toBe('pnpm --silent test:agent --coverage --reporter=blob --shard=${{ matrix.shard }}/4');
    const upload = shards.steps.find((step) => step.name === 'Upload shard report');
    expect(upload.with).toMatchObject({
      name: 'test-blob-${{ matrix.shard }}',
      path: '.vitest-reports/blob-${{ matrix.shard }}-4.json',
      'include-hidden-files': true, 'if-no-files-found': 'error',
    });
    const merge = aggregate.steps.find((step) => step.name === 'Require four reports and merge coverage');
    expect(merge.run).toContain('for shard in 1 2 3 4');
    expect(merge.run).toContain('test -s ".vitest-reports/blob-$shard-4.json"');
    expect(merge.run).toContain('pnpm --silent test:agent --merge-reports --coverage');
    expect(merge.run).toContain('test -s coverage/lcov.info');
    const artifact = aggregate.steps.at(-1);
    expect(artifact.with).toMatchObject({
      name: 'coverage-lcov', path: 'coverage/lcov.info', 'if-no-files-found': 'error',
    });
    expect(aggregate.steps.slice(1).every((step) => step.if === "github.event_name != 'merge_group'")).toBe(true);
    expect(read('scripts/test-agent-worker.mjs')).toContain('options.reporter ?? options.reporters ?? []');
  });
});

describe('database project selection', () => {
  it.each([
    ['apps/kernel/src/db/schemas/__tests__/thing-migration.test.ts', '', true],
    ['apps/kernel/src/db/__tests__/migration.test.ts', '', true],
    ['apps/kernel/app/api/__tests__/route.test.ts', "import { PGlite } from '@electric-sql/pglite';", true],
    ['apps/kernel/src/lib/__tests__/seed.test.ts', '// seed-replay suite', true],
    ['apps/kernel/app/__tests__/panel.test.tsx', 'ordinary jsdom suite', false],
    ['packages/auth/tests/policy.test.ts', 'ordinary unit suite', false],
  ])('classifies %s correctly', (path, source, expected) => {
    expect(isDatabaseTest(path, source)).toBe(expected);
  });

  it('discovers database suites without admitting build output or ordinary units', () => {
    const dir = mkdtempSync(join(tmpdir(), 'test-projects-'));
    for (const folder of ['apps/kernel/__tests__', 'apps/kernel/node_modules', 'packages/auth/tests']) {
      mkdirSync(join(dir, folder), { recursive: true });
    }
    writeFileSync(join(dir, 'apps/kernel/__tests__/db.test.ts'), 'PGlite');
    writeFileSync(join(dir, 'apps/kernel/node_modules/ignored.test.ts'), 'PGlite');
    writeFileSync(join(dir, 'packages/auth/tests/unit.test.ts'), 'unit');
    expect(databaseTestFiles(dir)).toEqual(['apps/kernel/__tests__/db.test.ts']);
  });

  it('scopes timeouts and single-worker DB execution to the database project', () => {
    const [unitProject, databaseProject] = workspace;
    expect(unitProject.test.name).toBe('unit');
    expect(unitProject.test.testTimeout).toBeUndefined();
    expect(unitProject.test.hookTimeout).toBeUndefined();
    expect(databaseProject.test).toMatchObject({
      name: 'database', testTimeout: 15_000, hookTimeout: 30_000,
      pool: 'threads', poolOptions: { threads: { singleThread: true } },
    });
    expect(databaseProject.test.include.length).toBeGreaterThan(0);
    const excluded = new Set(unitProject.test.exclude);
    expect(databaseProject.test.include.every((file) => excluded.has(file))).toBe(true);
    expect(read('vitest.config.ts')).not.toMatch(/testTimeout|hookTimeout|retry:/);
    const workspaceSource = read('vitest.workspace.ts');
    const unit = workspaceSource.slice(workspaceSource.indexOf("name: 'unit'"), workspaceSource.indexOf("name: 'database'"));
    expect(unit).toContain('exclude: [...configDefaults.exclude, ...databaseTests]');
    expect(unit).not.toMatch(/testTimeout|hookTimeout/);
    expect(workspaceSource).toContain('include: databaseTests');
    expect(workspaceSource).toContain('singleThread: true');
    expect(read('vitest.config.ts')).toContain('maxWorkers: 4');
    expect(workspaceSource).toContain('testTimeout: 15_000');
    expect(workspaceSource).toContain('hookTimeout: 30_000');
    expect(workspaceSource).not.toMatch(/retry:|\.skip/);
  });
});
