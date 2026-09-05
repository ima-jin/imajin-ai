import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveGitRef } from '../lib/git';
import { initFakeGitCheckout, setFakeGitHead } from './test-helpers/fake-git';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

describe('resolveGitRef', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'corpus-git-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolves HEAD via a symbolic ref to a loose branch ref file', () => {
    initFakeGitCheckout(dir);
    setFakeGitHead(dir, SHA_A);

    expect(resolveGitRef(dir)).toBe(SHA_A);
  });

  it('tracks HEAD as the loose ref is updated (simulating a new commit)', () => {
    initFakeGitCheckout(dir);
    setFakeGitHead(dir, SHA_A);
    expect(resolveGitRef(dir)).toBe(SHA_A);

    setFakeGitHead(dir, SHA_B);
    expect(resolveGitRef(dir)).toBe(SHA_B);
  });

  it('falls back to packed-refs when there is no loose ref file', () => {
    initFakeGitCheckout(dir);
    writeFileSync(
      join(dir, '.git', 'packed-refs'),
      '# pack-refs with: peeled fully-peeled sorted\n' + `${SHA_A} refs/heads/main\n`,
      'utf8',
    );

    expect(resolveGitRef(dir)).toBe(SHA_A);
  });

  it('prefers a loose ref over a stale packed-refs entry', () => {
    initFakeGitCheckout(dir);
    writeFileSync(join(dir, '.git', 'packed-refs'), `${SHA_B} refs/heads/main\n`, 'utf8');
    setFakeGitHead(dir, SHA_A);

    expect(resolveGitRef(dir)).toBe(SHA_A);
  });

  it('resolves a detached HEAD (HEAD containing a sha directly)', () => {
    mkdirSync(join(dir, '.git'), { recursive: true });
    writeFileSync(join(dir, '.git', 'HEAD'), `${SHA_A}\n`, 'utf8');

    expect(resolveGitRef(dir)).toBe(SHA_A);
  });

  it('resolves HEAD for a linked worktree via gitdir:/commondir indirection', () => {
    const commonGitDir = join(dir, 'main-repo', '.git');
    mkdirSync(join(commonGitDir, 'refs', 'heads'), { recursive: true });
    writeFileSync(join(commonGitDir, 'refs', 'heads', 'feature'), `${SHA_A}\n`, 'utf8');

    const worktreeGitDir = join(commonGitDir, 'worktrees', 'wt1');
    mkdirSync(worktreeGitDir, { recursive: true });
    writeFileSync(join(worktreeGitDir, 'HEAD'), 'ref: refs/heads/feature\n', 'utf8');
    writeFileSync(join(worktreeGitDir, 'commondir'), '../..\n', 'utf8');

    const worktreeCheckout = join(dir, 'worktree-checkout');
    mkdirSync(worktreeCheckout, { recursive: true });
    writeFileSync(join(worktreeCheckout, '.git'), `gitdir: ${worktreeGitDir}\n`, 'utf8');

    expect(resolveGitRef(worktreeCheckout)).toBe(SHA_A);
  });

  it('returns undefined when the symbolic ref points nowhere (no loose ref or packed-refs entry)', () => {
    initFakeGitCheckout(dir);

    expect(resolveGitRef(dir)).toBeUndefined();
  });

  it('returns undefined for a malformed HEAD file', () => {
    mkdirSync(join(dir, '.git'), { recursive: true });
    writeFileSync(join(dir, '.git', 'HEAD'), 'not a sha or symbolic ref\n', 'utf8');

    expect(resolveGitRef(dir)).toBeUndefined();
  });

  it('returns undefined for a malformed ".git" file (not a gitdir pointer)', () => {
    writeFileSync(join(dir, '.git'), 'not a gitdir pointer\n', 'utf8');

    expect(resolveGitRef(dir)).toBeUndefined();
  });

  it('returns undefined for a non-git directory', () => {
    expect(resolveGitRef(dir)).toBeUndefined();
  });

  it('returns undefined for a nonexistent directory', () => {
    expect(resolveGitRef(join(dir, 'does-not-exist'))).toBeUndefined();
  });
});
