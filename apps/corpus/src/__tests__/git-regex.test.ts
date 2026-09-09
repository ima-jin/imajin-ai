/**
 * S8786: `GITDIR_POINTER_PATTERN` in `../lib/git.ts` was rewritten to add a
 * `(?=\S)` lookahead that pins the boundary between the leading `\s*` and
 * the captured group, removing the super-linear backtracking that came from
 * `\s*` and `.+` both being able to match whitespace. This test proves the
 * new pattern captures exactly what the original pattern did on every real
 * ".git" pointer-file shape this module actually parses (see
 * `resolveGitDir` in `../lib/git.ts` and the worktree fixture in
 * `git.test.ts`), plus a few whitespace edge cases.
 */
import { describe, expect, it } from 'vitest';
import { GITDIR_POINTER_PATTERN } from '../lib/git';

// The pre-fix pattern, kept here only for comparison.
const OLD_GITDIR_POINTER_PATTERN = /^gitdir:\s*(.+)$/;

describe('GITDIR_POINTER_PATTERN (S8786 regression)', () => {
  const inputs = [
    // Real shape written by git for a linked worktree's ".git" file.
    'gitdir: /Users/dev/repo/.git/worktrees/wt1',
    // Windows-style absolute path.
    'gitdir: C:\\Users\\dev\\repo\\.git\\worktrees\\wt1',
    // Multiple spaces after the colon.
    'gitdir:   /abs/path/.git/worktrees/wt1',
    // Tab instead of a space.
    'gitdir:\t/abs/path/.git/worktrees/wt1',
    // No whitespace at all after the colon.
    'gitdir:/abs/path/.git/worktrees/wt1',
    // Path containing an internal space.
    'gitdir: /abs/path with spaces/.git/worktrees/wt1',
    // Not a gitdir pointer at all — both patterns should fail to match.
    'not a gitdir pointer',
  ];

  it.each(inputs)('matches identically to the original pattern for %j', (input) => {
    const oldMatch = OLD_GITDIR_POINTER_PATTERN.exec(input);
    const newMatch = GITDIR_POINTER_PATTERN.exec(input);

    expect(newMatch?.[1]).toBe(oldMatch?.[1]);
    expect(newMatch === null).toBe(oldMatch === null);
  });
});
