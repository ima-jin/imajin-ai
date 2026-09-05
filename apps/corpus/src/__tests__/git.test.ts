import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveGitRef } from '../lib/git';

function initGitRepo(dir: string): void {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'a'], { cwd: dir });
}

function commit(dir: string, file: string, content: string, message: string): string {
  writeFileSync(join(dir, file), content, 'utf8');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', message], { cwd: dir });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString('utf8').trim();
}

describe('resolveGitRef', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'corpus-git-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolves the current HEAD sha for a git checkout', () => {
    initGitRepo(dir);
    const sha = commit(dir, 'a.md', 'hello', 'A');

    expect(resolveGitRef(dir)).toBe(sha);
  });

  it('tracks HEAD as new commits land', () => {
    initGitRepo(dir);
    const shaA = commit(dir, 'a.md', 'hello', 'A');
    const shaB = commit(dir, 'a.md', 'hello world', 'B');

    expect(resolveGitRef(dir)).toBe(shaB);
    expect(shaB).not.toBe(shaA);
  });

  it('returns undefined for a non-git directory', () => {
    expect(resolveGitRef(dir)).toBeUndefined();
  });

  it('returns undefined for a nonexistent directory', () => {
    expect(resolveGitRef(join(dir, 'does-not-exist'))).toBeUndefined();
  });
});
