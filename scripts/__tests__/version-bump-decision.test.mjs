import { describe, it, expect } from 'vitest';
import {
  decideVersionBump,
  isReleaseBranch,
  isReleaseCommitMessage,
} from '../lib/version-bump-decision.mjs';

const BUMP = ['package.json: version changed from "0.8.13" to "0.8.14"'];

describe('decideVersionBump (#2619)', () => {
  it('(1) passes a release branch whose head is a merge commit', () => {
    const result = decideVersionBump({
      violations: BUMP,
      headRef: 'release/v0.8.14',
      // Only the "Update branch" merge is visible as a message; no release: commit needed.
      commitMessages: ["Merge branch 'main' into release/v0.8.14"],
    });
    expect(result).toEqual({ allowed: true, reason: 'release-branch' });
  });

  it('(2) passes when a release: commit is anywhere in the range', () => {
    const result = decideVersionBump({
      violations: BUMP,
      headRef: '',
      commitMessages: ['fix: something', 'release: v0.8.14', 'chore: tidy'],
    });
    expect(result).toEqual({ allowed: true, reason: 'release-commit' });
  });

  it('(3) fails a feature branch that bumps a version', () => {
    const result = decideVersionBump({
      violations: BUMP,
      headRef: 'feat/new-button',
      commitMessages: ['feat: add a button', 'chore: bump ui version'],
    });
    expect(result).toEqual({ allowed: false, reason: 'none' });
  });

  it('(4) fails a feature branch whose head is a merge commit and which bumps a version', () => {
    const result = decideVersionBump({
      violations: BUMP,
      headRef: 'feat/new-button',
      commitMessages: ["Merge branch 'main' into feat/new-button", 'feat: add a button'],
    });
    expect(result).toEqual({ allowed: false, reason: 'none' });
  });

  it('(5) passes when there is no version diff, regardless of branch or commits', () => {
    expect(decideVersionBump({ violations: [], headRef: 'feat/x', commitMessages: ['feat: x'] })).toEqual({
      allowed: true,
      reason: 'no-diff',
    });
  });

  it('defaults headRef/commitMessages to empty and fails closed', () => {
    expect(decideVersionBump({ violations: BUMP })).toEqual({ allowed: false, reason: 'none' });
  });
});

describe('isReleaseBranch', () => {
  it('matches release/v* only', () => {
    expect(isReleaseBranch('release/v0.8.14')).toBe(true);
    expect(isReleaseBranch('release/v1')).toBe(true);
    expect(isReleaseBranch('release/0.8.14')).toBe(false);
    expect(isReleaseBranch('releases/v1')).toBe(false);
    expect(isReleaseBranch('feat/release/v1')).toBe(false);
    expect(isReleaseBranch('')).toBe(false);
    expect(isReleaseBranch(undefined)).toBe(false);
  });
});

describe('isReleaseCommitMessage', () => {
  it('matches a leading release: prefix, case-insensitively', () => {
    expect(isReleaseCommitMessage('release: v0.8.14')).toBe(true);
    expect(isReleaseCommitMessage('Release: v0.8.14\n\nbody')).toBe(true);
    expect(isReleaseCommitMessage("Merge branch 'main' into release/v0.8.14")).toBe(false);
    expect(isReleaseCommitMessage('feat: mentions release: later')).toBe(false);
    expect(isReleaseCommitMessage(undefined)).toBe(false);
  });
});
