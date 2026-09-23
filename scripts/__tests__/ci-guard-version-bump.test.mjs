import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not `.pathname`: on Windows the latter yields "/D:/...", which
// node then resolves against the cwd into "C:\D:\..." and cannot load.
const SCRIPT = fileURLToPath(new URL('../ci-guard-version-bump.mjs', import.meta.url));

function git(dir, args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

function writePackageJson(dir, relPath, contents) {
  const fullPath = join(dir, relPath);
  mkdirSync(join(fullPath, '..'), { recursive: true });
  writeFileSync(fullPath, `${JSON.stringify(contents, null, 2)}\n`, 'utf8');
}

function commitAll(dir, message) {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', message]);
}

/**
 * Sets up a temp repo with an `origin/main` remote-tracking ref at a base
 * commit (root + one package manifest, both version 0.8.0), plus a `HEAD`
 * commit on a feature branch that callers customize per-test.
 */
function makeBaseRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'version-bump-guard-'));

  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);

  writePackageJson(dir, 'package.json', { name: 'imajin-ai', version: '0.8.0', private: true });
  writePackageJson(dir, 'packages/ui/package.json', { name: '@imajin/ui', version: '1.2.3' });
  commitAll(dir, 'base');

  // Simulate a fetched origin/main remote-tracking ref pointing at the base commit.
  const baseSha = git(dir, ['rev-parse', 'HEAD']).trim();
  git(dir, ['update-ref', 'refs/remotes/origin/main', baseSha]);

  git(dir, ['checkout', '-q', '-b', 'feature']);
  return dir;
}

function runGuard(dir, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      cwd: dir,
      env: { ...process.env, NODE_PATH: join(process.cwd(), 'node_modules'), CI_GUARD_WORKDIR: dir, ...env },
    });
    return { stdout, stderr: '', status: 0 };
  } catch (e) {
    return {
      stdout: e.stdout?.toString() ?? '',
      stderr: e.stderr?.toString() ?? '',
      status: e.status ?? 1,
    };
  }
}

function expectPass(result) {
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('PASS');
}

function expectFail(result, ...expectedSubstrings) {
  expect(result.status).toBe(1);
  const combined = result.stdout + result.stderr;
  expect(combined).toContain('FAIL');
  for (const substring of expectedSubstrings) {
    expect(combined).toContain(substring);
  }
}

describe('ci-guard-version-bump', () => {
  it('passes when no package.json version differs from origin/main', () => {
    const dir = makeBaseRepo();
    writeFileSync(join(dir, 'README.md'), 'unrelated change\n', 'utf8');
    commitAll(dir, 'docs: unrelated change');

    expectPass(runGuard(dir));
  });

  it('fails a PR that bumps a version field without a release: commit', () => {
    const dir = makeBaseRepo();
    writePackageJson(dir, 'packages/ui/package.json', { name: '@imajin/ui', version: '1.3.0' });
    commitAll(dir, 'feat: add a button');

    expectFail(runGuard(dir), 'packages/ui/package.json', '1.2.3', '1.3.0', 'release:');
  });

  it('passes the same version bump when the head commit message starts with "release:"', () => {
    const dir = makeBaseRepo();
    writePackageJson(dir, 'package.json', { name: 'imajin-ai', version: '0.8.1', private: true });
    writePackageJson(dir, 'packages/ui/package.json', { name: '@imajin/ui', version: '1.3.0' });
    commitAll(dir, 'release: v0.8.1');

    expectPass(runGuard(dir));
  });

  it('is case-insensitive and tolerant of a scoped prefix like "release: v..."', () => {
    const dir = makeBaseRepo();
    writePackageJson(dir, 'package.json', { name: 'imajin-ai', version: '0.9.0', private: true });
    commitAll(dir, 'Release: v0.9.0');

    expectPass(runGuard(dir));
  });

  it('does not flag a brand-new package.json with no origin/main counterpart', () => {
    const dir = makeBaseRepo();
    writePackageJson(dir, 'packages/new-thing/package.json', { name: '@imajin/new-thing', version: '0.1.0' });
    commitAll(dir, 'feat: scaffold new-thing package');

    expectPass(runGuard(dir));
  });

  it('reads the real PR commit message off a synthetic merge commit (HEAD^2), not the merge commit itself', () => {
    const dir = makeBaseRepo();
    // Feature branch is the Release workflow's own commit shape.
    writePackageJson(dir, 'package.json', { name: 'imajin-ai', version: '0.8.1', private: true });
    writePackageJson(dir, 'packages/ui/package.json', { name: '@imajin/ui', version: '1.3.0' });
    commitAll(dir, 'release: v0.8.1');
    const featureSha = git(dir, ['rev-parse', 'HEAD']).trim();

    // Simulate GitHub's PR merge-commit checkout: merge feature into main,
    // producing a merge commit whose OWN message is generic (does not start
    // with "release:"), with the real "release:" commit as its second parent.
    // If the guard read HEAD's own message instead of HEAD^2, this would
    // wrongly fail.
    git(dir, ['checkout', '-q', 'main']);
    git(dir, ['merge', '--no-ff', '-q', '-m', 'Merge feature into main', featureSha]);

    expectPass(runGuard(dir));
  });

  it('fails when the real PR commit behind a merge commit is not a release: commit', () => {
    const dir = makeBaseRepo();
    writePackageJson(dir, 'packages/ui/package.json', { name: '@imajin/ui', version: '1.3.0' });
    commitAll(dir, 'feat: bump ui for a reason');
    const featureSha = git(dir, ['rev-parse', 'HEAD']).trim();

    git(dir, ['checkout', '-q', 'main']);
    git(dir, ['merge', '--no-ff', '-q', '-m', 'Merge feature into main', featureSha]);

    expectFail(runGuard(dir), 'packages/ui/package.json', 'release:');
  });
});
