import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { checkPullMigrations, recheckOpenPulls } from '../migration-collision-recheck.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const directories = [];
let fixture;

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function commit(cwd, message) {
  git(cwd, 'add', '.');
  git(cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

beforeAll(() => {
  const cwd = mkdtempSync(join(tmpdir(), 'migration-recheck-test-'));
  directories.push(cwd);
  git(cwd, 'init', '-q');
  mkdirSync(join(cwd, 'scripts'));
  mkdirSync(join(cwd, 'migrations'));
  writeFileSync(join(cwd, 'scripts/check-migrations.sh'),
    readFileSync(join(ROOT, 'scripts/check-migrations.sh')));
  writeFileSync(join(cwd, 'migrations/0001_baseline.sql'), 'SELECT 1;\n');
  const base = commit(cwd, 'base');

  writeFileSync(join(cwd, 'migrations/0002_pr.sql'), 'SELECT 2;\n');
  // A PR cannot substitute an always-green checker or execute its SQL.
  writeFileSync(join(cwd, 'scripts/check-migrations.sh'), 'exit 0\n');
  const collision = commit(cwd, 'colliding PR');
  git(cwd, 'checkout', '-q', base);
  writeFileSync(join(cwd, 'migrations/0003_pr.sql'), 'SELECT 3;\n');
  const clean = commit(cwd, 'clean PR');
  git(cwd, 'checkout', '-q', base);
  writeFileSync(join(cwd, 'README.txt'), 'no migrations\n');
  const unrelated = commit(cwd, 'unrelated PR');
  git(cwd, 'checkout', '-q', base);
  writeFileSync(join(cwd, 'migrations/0002_main.sql'), 'SELECT 2;\n');
  const main = commit(cwd, 'main takes number 0002');
  fixture = { cwd, main, collision, clean, unrelated };
});

afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

describe('unchanged checker against main plus PR migrations', () => {
  it('fails a stale colliding PR and names both files using the checker output', () => {
    const result = checkPullMigrations({ ...fixture, head: fixture.collision });
    expect(result.conclusion).toBe('failure');
    expect(result.output).toContain('0002_main.sql');
    expect(result.output).toContain('0002_pr.sql: duplicate migration number 0002');
  });

  it('passes a stale PR with a different number', () => {
    const result = checkPullMigrations({ ...fixture, head: fixture.clean });
    expect(result.conclusion).toBe('success');
    expect(result.output).toContain('0002_main.sql');
    expect(result.output).toContain('0003_pr.sql');
  });

  it('does not run the checker for non-migration PRs', () => {
    expect(checkPullMigrations({ ...fixture, head: fixture.unrelated })).toBeNull();
  });

  it('retains checker validation for an empty migration', () => {
    git(fixture.cwd, 'checkout', '-q', fixture.main);
    writeFileSync(join(fixture.cwd, 'migrations/0003_empty.sql'), '');
    const head = commit(fixture.cwd, 'empty migration');
    const result = checkPullMigrations({ ...fixture, head });
    expect(result.conclusion).toBe('failure');
    expect(result.output).toContain('0003_empty.sql: empty file');
  });

  it('retains checker validation for an invalid filename', () => {
    git(fixture.cwd, 'checkout', '-q', fixture.main);
    writeFileSync(join(fixture.cwd, 'migrations/invalid.sql'), 'SELECT 3;\n');
    const head = commit(fixture.cwd, 'invalid migration filename');
    const result = checkPullMigrations({ ...fixture, head });
    expect(result.conclusion).toBe('failure');
    expect(result.output).toContain('invalid.sql: invalid naming format');
  });

  it('overlays renames without leaving the old file to cause a false collision', () => {
    git(fixture.cwd, 'checkout', '-q', fixture.main);
    git(fixture.cwd, 'mv', 'migrations/0002_main.sql', 'migrations/0002_renamed.sql');
    const head = commit(fixture.cwd, 'rename migration');
    const result = checkPullMigrations({ ...fixture, head });
    expect(result.conclusion).toBe('success');
    expect(result.output).toContain('0002_renamed.sql');
    expect(result.output).not.toContain('0002_main.sql');
  });
});

function pull(number, repository = 'ima-jin/imajin-ai') {
  return { number, head: { sha: `head-${number}`, repo: repository && { full_name: repository } } };
}

function harness(pulls = [pull(1), pull(2), pull(3)]) {
  const create = vi.fn().mockResolvedValue({});
  const github = {
    paginate: vi.fn().mockResolvedValue(pulls),
    rest: { pulls: { list: vi.fn() }, checks: { create } },
  };
  const context = {
    repo: { owner: 'ima-jin', repo: 'imajin-ai' },
    serverUrl: 'https://github.com', runId: 123,
  };
  const core = { info: vi.fn(), error: vi.fn(), setFailed: vi.fn() };
  const fetch = vi.fn().mockReturnValue(Buffer.from('main-sha\n'));
  const check = vi.fn()
    .mockReturnValueOnce({ conclusion: 'failure', output: '0002_pr.sql: duplicate migration number 0002\n0002_main.sql' })
    .mockReturnValueOnce({ conclusion: 'success', output: 'All migrations valid.' })
    .mockReturnValueOnce(null);
  return { github, context, core, fetch, check };
}

describe('live PR enumeration and advisory checks', () => {
  it('paginates all open main PRs and reports only migration PRs on their exact heads', async () => {
    const h = harness();
    await recheckOpenPulls(h);
    expect(h.github.paginate).toHaveBeenCalledWith(h.github.rest.pulls.list, {
      owner: 'ima-jin', repo: 'imajin-ai', state: 'open', base: 'main', per_page: 100,
    });
    expect(h.fetch.mock.calls.slice(0, 2)).toEqual([
      [['fetch', 'origin', 'main']], [['rev-parse', 'origin/main']],
    ]);
    expect(h.check).toHaveBeenCalledWith(expect.objectContaining({ main: 'main-sha', head: 'head-1' }));
    const reports = h.github.rest.checks.create.mock.calls.map(([report]) => report);
    expect(reports).toHaveLength(2);
    expect(reports[0]).toMatchObject({
      head_sha: 'head-1', name: 'Check Migrations (vs main)',
      status: 'completed', conclusion: 'failure',
      details_url: 'https://github.com/ima-jin/imajin-ai/actions/runs/123',
      output: { text: '0002_pr.sql: duplicate migration number 0002\n0002_main.sql' },
    });
    expect(reports[1]).toMatchObject({ head_sha: 'head-2', conclusion: 'success' });
    expect(h.core.setFailed).not.toHaveBeenCalled();
  });

  it.each(['outside/fork', null])('logs and skips an unwritable head (%s)', async (repository) => {
    const h = harness([pull(4, repository)]);
    await recheckOpenPulls(h);
    expect(h.core.info).toHaveBeenCalledWith(expect.stringContaining('Skipping fork/deleted head'));
    expect(h.check).not.toHaveBeenCalled();
    expect(h.github.rest.checks.create).not.toHaveBeenCalled();
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it('continues reporting other PRs after a denied check write and fails visibly', async () => {
    const h = harness();
    h.github.rest.checks.create.mockRejectedValueOnce(new Error('403 permission denied'));
    await recheckOpenPulls(h);
    expect(h.github.rest.checks.create).toHaveBeenCalledTimes(2);
    expect(h.core.error).toHaveBeenCalledWith('PR #1: 403 permission denied');
    expect(h.core.setFailed).toHaveBeenCalledOnce();
  });

  it('does not claim success when a PR fetch fails; continues with later PRs', async () => {
    const h = harness();
    h.fetch.mockImplementation((args) => {
      if (args.includes('head-1')) throw new Error('unavailable head');
      return Buffer.from('main-sha');
    });
    await recheckOpenPulls(h);
    expect(h.core.error).toHaveBeenCalledWith('PR #1: unavailable head');
    expect(h.check).toHaveBeenCalledTimes(2);
    expect(h.github.rest.checks.create).not.toHaveBeenCalledWith(
      expect.objectContaining({ head_sha: 'head-1' }),
    );
    expect(h.core.setFailed).toHaveBeenCalledOnce();
  });

  it('stops before any report if main cannot be fetched', async () => {
    const h = harness();
    h.fetch.mockImplementation(() => { throw new Error('main unavailable'); });
    await expect(recheckOpenPulls(h)).rejects.toThrow('main unavailable');
    expect(h.github.rest.checks.create).not.toHaveBeenCalled();
  });

  it('bounds check text while retaining final checker error lines', async () => {
    const h = harness([pull(1)]);
    h.check.mockReset().mockReturnValue({ conclusion: 'failure', output: `${'x'.repeat(70_000)}\ncollision.sql` });
    await recheckOpenPulls(h);
    const report = h.github.rest.checks.create.mock.calls[0][0];
    expect(report.output.text.length).toBeLessThanOrEqual(15_000);
    expect(report.output.text).toMatch(/collision\.sql$/);
  });
});

describe('workflow contract', () => {
  const workflow = YAML.parse(readFileSync(join(ROOT, '.github/workflows/migration-collision-recheck.yml'), 'utf8'));

  it('runs for migration pushes on main and live manual dispatch, with no PR-code trigger', () => {
    expect(workflow.on).toEqual({
      push: { branches: ['main'], paths: ['migrations/**'] }, workflow_dispatch: null,
    });
    expect(workflow.concurrency).toEqual({ group: 'migration-collision-recheck', 'cancel-in-progress': false });
  });

  it('grants only read access plus check writes, without persisted checkout credentials', () => {
    expect(workflow.permissions).toEqual({ contents: 'read', 'pull-requests': 'read', checks: 'write' });
    const steps = workflow.jobs.recheck.steps;
    expect(steps[0].with).toEqual({ 'fetch-depth': 0, 'persist-credentials': false });
    expect(steps.at(-1).with.script).toContain('await recheckOpenPulls({ github, context, core })');
  });

  it('keeps the check advisory, outside required contexts', () => {
    expect(readFileSync(join(ROOT, '.github/required-checks.json'), 'utf8'))
      .not.toContain('Check Migrations (vs main)');
  });
});
