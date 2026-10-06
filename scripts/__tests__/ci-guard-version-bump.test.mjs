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
      env: {
        ...process.env,
        NODE_PATH: join(process.cwd(), 'node_modules'),
        CI_GUARD_WORKDIR: dir,
        // Neutralise ambient values: on a release/v* PR the runner itself sets GITHUB_HEAD_REF.
        GITHUB_HEAD_REF: '',
        CI_GUARD_PR_HEAD_REF: '',
        ...env,
      },
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

  describe('"Update branch" merge commit on top of the PR branch (#2619)', () => {
    /** Branch off base with a version-bumping commit, then merge a newer main into it. */
    function makeBranchWithUpdateBranchMerge(bumpMessage) {
      const dir = makeBaseRepo();
      writePackageJson(dir, 'package.json', { name: 'imajin-ai', version: '0.8.1', private: true });
      writePackageJson(dir, 'packages/ui/package.json', { name: '@imajin/ui', version: '1.3.0' });
      commitAll(dir, bumpMessage);

      // main moves on (unrelated change), and origin/main follows.
      git(dir, ['checkout', '-q', 'main']);
      writeFileSync(join(dir, 'CHANGELOG.md'), 'newer main\n', 'utf8');
      commitAll(dir, 'docs: newer main');
      git(dir, ['update-ref', 'refs/remotes/origin/main', git(dir, ['rev-parse', 'HEAD']).trim()]);

      // "Update branch": merge main into the PR branch -> merge commit is the head.
      git(dir, ['checkout', '-q', 'feature']);
      git(dir, ['merge', '--no-ff', '-q', '-m', "Merge branch 'main' into feature", 'main']);
      expect(git(dir, ['log', '-1', '--format=%P']).trim().split(' ')).toHaveLength(2);
      return dir;
    }

    it('passes when a release: commit sits below the merge commit', () => {
      const dir = makeBranchWithUpdateBranchMerge('release: v0.8.1');
      const result = runGuard(dir);
      expectPass(result);
      expect(result.stdout).toContain('release:');
    });

    it('passes a release/v* head ref even with no release: commit anywhere', () => {
      const dir = makeBranchWithUpdateBranchMerge('chore: bump versions');
      const result = runGuard(dir, { GITHUB_HEAD_REF: 'release/v0.8.1' });
      expectPass(result);
      expect(result.stdout).toContain('release/v*');
    });

    it('reads the head ref from CI_GUARD_PR_HEAD_REF, as ci.yml passes it', () => {
      const dir = makeBranchWithUpdateBranchMerge('chore: bump versions');
      expectPass(runGuard(dir, { CI_GUARD_PR_HEAD_REF: 'release/v0.8.1' }));
    });

    it('still fails a feature branch whose head is a merge commit and which bumps a version', () => {
      const dir = makeBranchWithUpdateBranchMerge('feat: bump ui by hand');
      expectFail(runGuard(dir, { GITHUB_HEAD_REF: 'feat/bump-ui' }), 'packages/ui/package.json', 'release/v*', 'release:');
    });

    it('does not treat a branch-name lookalike (feature/release/v*) as a release branch', () => {
      const dir = makeBranchWithUpdateBranchMerge('feat: bump ui by hand');
      expectFail(runGuard(dir, { GITHUB_HEAD_REF: 'feature/release/v0.8.1' }), 'packages/ui/package.json');
    });

    it('does not use a release: commit that is already on the base (not in base..head)', () => {
      const dir = makeBaseRepo();
      // A release commit lands on main and the base ref advances past it.
      git(dir, ['checkout', '-q', 'main']);
      writeFileSync(join(dir, 'RELEASES.md'), 'v0.8.0\n', 'utf8');
      commitAll(dir, 'release: v0.8.0');
      git(dir, ['update-ref', 'refs/remotes/origin/main', git(dir, ['rev-parse', 'HEAD']).trim()]);

      git(dir, ['checkout', '-q', 'feature']);
      writePackageJson(dir, 'packages/ui/package.json', { name: '@imajin/ui', version: '1.3.0' });
      commitAll(dir, 'feat: bump ui by hand');
      git(dir, ['merge', '--no-ff', '-q', '-m', "Merge branch 'main' into feature", 'main']);

      expectFail(runGuard(dir), 'packages/ui/package.json');
    });
  });
});
