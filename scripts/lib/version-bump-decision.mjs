/**
 * Pure decision logic for `scripts/ci-guard-version-bump.mjs` (#2285, #2619).
 *
 * No git, no env, no process access: callers gather the inputs and this
 * function only decides, so every case is unit-testable.
 *
 * A version-field difference against the base is allowed when EITHER:
 *   1. the PR head ref (GITHUB_HEAD_REF, pull_request events only) starts
 *      with `release/v` — the branch shape the Release workflow creates; OR
 *   2. any commit message in the base..head range starts with `release:`
 *      (case-insensitive) — the Release workflow's own commit shape.
 *
 * Merge commits are deliberately not special-cased: an "Update branch" merge
 * on top of a release commit passes because the release commit (or branch
 * name) is still found, while a merge commit on a feature branch carries
 * neither signal and still fails.
 */

export const RELEASE_COMMIT_PREFIX = 'release:';
export const RELEASE_BRANCH_PREFIX = 'release/v';

/** True when `headRef` names a release branch (`release/v*`). */
export function isReleaseBranch(headRef) {
  return typeof headRef === 'string' && headRef.trim().startsWith(RELEASE_BRANCH_PREFIX);
}

/** True when `message` starts with `release:` (case-insensitive, leading whitespace ignored). */
export function isReleaseCommitMessage(message) {
  return typeof message === 'string' && message.trim().toLowerCase().startsWith(RELEASE_COMMIT_PREFIX);
}

/**
 * @param {object} input
 * @param {string[]} input.violations     version-field differences vs the base ref
 * @param {string}  [input.headRef]       PR head ref (GITHUB_HEAD_REF); empty outside pull_request events
 * @param {string[]} [input.commitMessages] messages of every commit in base..head
 * @returns {{ allowed: boolean, reason: 'no-diff' | 'release-branch' | 'release-commit' | 'none' }}
 */
export function decideVersionBump({ violations, headRef = '', commitMessages = [] }) {
  if (violations.length === 0) return { allowed: true, reason: 'no-diff' };
  if (isReleaseBranch(headRef)) return { allowed: true, reason: 'release-branch' };
  if (commitMessages.some(isReleaseCommitMessage)) return { allowed: true, reason: 'release-commit' };
  return { allowed: false, reason: 'none' };
}
