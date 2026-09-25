import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { latestTagVersion, parseVersion, compareVersions } from '../ci-guard-version-tag-sync.mjs';

// fileURLToPath, not `.pathname`: on Windows the latter yields "/D:/...", which
// node then resolves against the cwd into "C:\D:\..." and cannot load.
const SCRIPT = fileURLToPath(new URL('../ci-guard-version-tag-sync.mjs', import.meta.url));

function git(dir, args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

function writePackageJson(dir, contents) {
  const fullPath = join(dir, 'package.json');
  mkdirSync(dir, { recursive: true });
  writeFileSync(fullPath, `${JSON.stringify(contents, null, 2)}\n`, 'utf8');
}

/** A repo with root package.json at `packageVersion`, optionally tagged `v${tag}` on that same commit. */
function makeRepo(packageVersion, tag) {
  const dir = mkdtempSync(join(tmpdir(), 'version-tag-sync-'));

  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);

  writePackageJson(dir, { name: 'imajin-ai', version: packageVersion, private: true });
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'base']);

  if (tag) {
    git(dir, ['tag', '-a', `v${tag}`, '-m', `v${tag}`]);
  }

  return dir;
}

function runGuard(dir) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      cwd: dir,
      env: { ...process.env, NODE_PATH: join(process.cwd(), 'node_modules'), CI_GUARD_WORKDIR: dir },
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

describe('parseVersion', () => {
  it('parses a plain major.minor.patch string', () => {
    expect(parseVersion('0.8.5')).toEqual([0, 8, 5]);
  });

  it('returns undefined for a non major.minor.patch string', () => {
    expect(parseVersion('0.8.5-rc.1')).toBeUndefined();
    expect(parseVersion(undefined)).toBeUndefined();
  });
});

describe('compareVersions', () => {
  it('orders by major, then minor, then patch', () => {
    expect(compareVersions([0, 8, 2], [0, 8, 5])).toBeLessThan(0);
    expect(compareVersions([0, 8, 5], [0, 8, 2])).toBeGreaterThan(0);
    expect(compareVersions([0, 8, 5], [0, 8, 5])).toBe(0);
    expect(compareVersions([0, 9, 0], [0, 8, 9])).toBeGreaterThan(0);
  });
});

describe('latestTagVersion', () => {
  it('returns the leading-v-stripped version of the latest reachable vX.Y.Z tag', () => {
    const dir = makeRepo('0.8.2', '0.8.5');
    expect(latestTagVersion('git', dir)).toBe('0.8.5');
  });

  it('returns undefined when no vX.Y.Z tag is reachable', () => {
    const dir = makeRepo('0.8.2');
    expect(latestTagVersion('git', dir)).toBeUndefined();
  });
});

describe('ci-guard-version-tag-sync', () => {
  it('passes when no vX.Y.Z tag is reachable yet', () => {
    const dir = makeRepo('0.1.0');
    expectPass(runGuard(dir));
  });

  it('passes when package.json matches the latest tag', () => {
    const dir = makeRepo('0.8.5', '0.8.5');
    expectPass(runGuard(dir));
  });

  it('passes when package.json is ahead of the latest tag (mid-release, pre-tag-release.yml)', () => {
    const dir = makeRepo('0.8.6', '0.8.5');
    expectPass(runGuard(dir));
  });

  // Reproduces #2349: v0.8.3–v0.8.5 were pushed as manual hot-fix tags while
  // root package.json stayed at 0.8.2.
  it('fails when package.json is behind the latest tag', () => {
    const dir = makeRepo('0.8.2', '0.8.5');
    expectFail(runGuard(dir), '0.8.2', '0.8.5', '#2349');
  });
});
