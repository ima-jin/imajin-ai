import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  KNOWN_GIT_LOCATIONS,
  resolveGitBinary,
  ensureSafeDirectory,
  latestTagVersion,
} from '../lib/git-version.mjs';

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
  const dir = mkdtempSync(join(tmpdir(), 'git-version-lib-'));

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

describe('resolveGitBinary', () => {
  it('returns GIT_BIN when set, without checking the filesystem', () => {
    const original = process.env.GIT_BIN;
    process.env.GIT_BIN = '/custom/path/to/git';
    try {
      expect(resolveGitBinary()).toBe('/custom/path/to/git');
    } finally {
      if (original === undefined) delete process.env.GIT_BIN;
      else process.env.GIT_BIN = original;
    }
  });

  it('falls back to a known install location when GIT_BIN is unset', () => {
    const original = process.env.GIT_BIN;
    delete process.env.GIT_BIN;
    try {
      const resolved = resolveGitBinary();
      expect(KNOWN_GIT_LOCATIONS).toContain(resolved);
    } finally {
      if (original !== undefined) process.env.GIT_BIN = original;
    }
  });
});

describe('ensureSafeDirectory', () => {
  it('does not throw even when given a bogus git binary path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'safe-dir-'));
    expect(() => ensureSafeDirectory('/no/such/git', dir)).not.toThrow();
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
