/**
 * Tests for scripts/detect-release-commit.mjs and its wiring into
 * tag-release.yml (#2685).
 *
 * v0.8.15's release branch had `main` merged into it, so the merge commit's
 * HEAD^2 was `Merge branch 'main' into release/v0.8.15`, not `release: v0.8.15`.
 * The old check read only HEAD^2's first line and skipped the release green.
 *
 * The CLI tests build real throwaway git repos with the exact commit shapes
 * and run the script against them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { resolveGitBinary } from '../lib/git-version.mjs';
import {
  detectReleaseCommit,
  isReleaseLine,
  releaseBranchFromMergeMessage,
  MAX_WALK,
} from '../detect-release-commit.mjs';

const SCRIPT = fileURLToPath(new URL('../detect-release-commit.mjs', import.meta.url));
const WORKFLOW = fileURLToPath(new URL('../../.github/workflows/tag-release.yml', import.meta.url));
const GIT = resolveGitBinary();

// ── pure unit tests ──────────────────────────────────────────────────────────

describe('releaseBranchFromMergeMessage', () => {
  it.each([
    ['Merge pull request #2670 from ima-jin/release/v0.8.15\n\nrelease: v0.8.15', 'release/v0.8.15'],
    ['Merge pull request #1 from someone/release/v1.0.0', 'release/v1.0.0'],
  ])('parses %j', (message, branch) => {
    expect(releaseBranchFromMergeMessage(message)).toBe(branch);
  });

  it.each([
    'Merge pull request #2676 from ima-jin/gap/2645-publish-onboard',
    'Merge pull request #5 from ima-jin/feature/release/v1.0.0-notes',
    "Merge branch 'main' into release/v0.8.15",
    'release: v0.8.15',
    '',
  ])('ignores %j', (message) => {
    expect(releaseBranchFromMergeMessage(message)).toBeUndefined();
  });
});

describe('isReleaseLine', () => {
  it('matches only the release: v prefix', () => {
    expect(isReleaseLine('release: v0.8.15')).toBe(true);
    expect(isReleaseLine('release: v0.8.14 (re-stamp)')).toBe(true);
    expect(isReleaseLine('chore: release: v0.8.15')).toBe(false);
    expect(isReleaseLine("Merge branch 'main' into release/v0.8.15")).toBe(false);
  });
});

describe('detectReleaseCommit (injected repo)', () => {
  function fakeRepo(commits, { mergeBase } = {}) {
    return {
      parents: (sha) => commits[sha].parents,
      message: (sha) => commits[sha].message,
      mergeBase: () => mergeBase,
      branchChain: (tip, _base, limit) => {
        const out = [];
        for (let sha = tip; sha && out.length < limit; sha = commits[sha].parents[0]) {
          if (sha === mergeBase) break;
          out.push({ sha, message: commits[sha].message });
        }
        return out;
      },
    };
  }

  it('is bounded: a release commit beyond MAX_WALK is not found', () => {
    const commits = { M: { parents: ['main', 'c0'], message: 'Merge pull request #9 from ima-jin/release/v9.9.9' } };
    const total = MAX_WALK + 5;
    for (let i = 0; i < total; i++) {
      commits[`c${i}`] = {
        parents: i === total - 1 ? [] : [`c${i + 1}`],
        message: i === total - 1 ? 'release: v9.9.9' : `work ${i}`,
      };
    }
    const result = detectReleaseCommit(fakeRepo(commits), 'M');
    expect(result.error).toMatch(/release\/v9\.9\.9/);
  });
});

// ── real-git fixtures ────────────────────────────────────────────────────────

let dir;
let counter = 0;

function git(...args) {
  return execFileSync(GIT, args, {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
  }).trim();
}

function commit(message) {
  // A unique file per commit so merges never conflict.
  writeFileSync(join(dir, `f${++counter}.txt`), `${counter}\n`);
  git('add', '-A');
  git('commit', '-q', '-m', message);
  return git('rev-parse', 'HEAD');
}

/** Merge `branch` into the current branch with a GitHub-style PR merge message. */
function mergePr(branch, number, body = '') {
  git('merge', '--no-ff', '-q', branch, '-m', `Merge pull request #${number} from ima-jin/${branch}\n\n${body}`);
  return git('rev-parse', 'HEAD');
}

function detect(sha) {
  const out = join(dir, `out-${++counter}.txt`);
  writeFileSync(out, '');
  const result = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, TARGET_SHA: sha, DETECT_WORKDIR: dir, GITHUB_OUTPUT: out, GIT_BIN: GIT },
  });
  const outputs = Object.fromEntries(
    readFileSync(out, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );
  return { status: result.status, stdout: result.stdout, outputs };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'detect-release-'));
  git('init', '-q', '-b', 'main');
  commit('initial');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('detect-release-commit.mjs against real git history', () => {
  it('plain release merge: HEAD^2 is the release commit — tags the merge commit, as before', () => {
    git('checkout', '-q', '-b', 'release/v1.0.0', 'main');
    const rel = commit('release: v1.0.0');
    git('checkout', '-q', 'main');
    commit('main moves on');
    const merge = mergePr('release/v1.0.0', 100, 'release: v1.0.0');

    const r = detect(merge);
    expect(r.status).toBe(0);
    expect(r.outputs).toEqual({ target_sha: merge, first_line: 'release: v1.0.0', is_release: 'true' });
    expect(r.outputs.target_sha).not.toBe(rel);
  });

  it('release branch with main merged in (the v0.8.15 shape): tags the release commit', () => {
    git('checkout', '-q', '-b', 'release/v0.8.15', 'main');
    const rel = commit('release: v0.8.15');
    git('checkout', '-q', 'main');
    commit('feature 2667 lands on main');
    git('checkout', '-q', 'release/v0.8.15');
    git('merge', '--no-ff', '-q', 'main', '-m', "Merge branch 'main' into release/v0.8.15");
    expect(git('log', '-1', '--format=%s')).toBe("Merge branch 'main' into release/v0.8.15");
    expect(git('rev-parse', 'HEAD^1')).toBe(rel);
    git('checkout', '-q', 'main');
    commit('another main commit');
    const merge = mergePr('release/v0.8.15', 101, "Merge branch 'main' into release/v0.8.15");

    const r = detect(merge);
    expect(r.status).toBe(0);
    expect(r.outputs).toEqual({ target_sha: rel, first_line: 'release: v0.8.15', is_release: 'true' });
  });

  it('release branch with main merged in twice and extra commits on top still finds the release commit', () => {
    git('checkout', '-q', '-b', 'release/v0.9.0', 'main');
    const rel = commit('release: v0.9.0');
    commit('fixup on release branch');
    git('checkout', '-q', 'main');
    commit('main A');
    git('checkout', '-q', 'release/v0.9.0');
    git('merge', '--no-ff', '-q', 'main', '-m', "Merge branch 'main' into release/v0.9.0");
    git('checkout', '-q', 'main');
    commit('main B');
    git('checkout', '-q', 'release/v0.9.0');
    git('merge', '--no-ff', '-q', 'main', '-m', "Merge branch 'main' into release/v0.9.0");
    git('checkout', '-q', 'main');
    const merge = mergePr('release/v0.9.0', 102);

    const r = detect(merge);
    expect(r.status).toBe(0);
    expect(r.outputs.target_sha).toBe(rel);
    expect(r.outputs.is_release).toBe('true');
  });

  it('non-release feature merge: is_release=false, exits green', () => {
    git('checkout', '-q', '-b', 'feat/thing', 'main');
    commit('feat: add a thing');
    git('checkout', '-q', 'main');
    const merge = mergePr('feat/thing', 103);

    const r = detect(merge);
    expect(r.status).toBe(0);
    expect(r.outputs.is_release).toBe('false');
    expect(r.outputs.target_sha).toBe(merge);
    expect(r.outputs.first_line).toBe('feat: add a thing');
  });

  it('feature branch that merged main in and mentions release in a body is not a release', () => {
    git('checkout', '-q', '-b', 'feat/other', 'main');
    commit('feat: other\n\nrelease: v9.9.9 is mentioned in the body only');
    git('checkout', '-q', 'main');
    commit('main moves');
    git('checkout', '-q', 'feat/other');
    git('merge', '--no-ff', '-q', 'main', '-m', "Merge branch 'main' into feat/other");
    git('checkout', '-q', 'main');
    const merge = mergePr('feat/other', 104);

    const r = detect(merge);
    expect(r.status).toBe(0);
    expect(r.outputs.is_release).toBe('false');
  });

  it('squash / direct push with a release message: HEAD itself is tagged', () => {
    git('checkout', '-q', 'main');
    const sha = commit('release: v1.2.3');

    const r = detect(sha);
    expect(r.status).toBe(0);
    expect(r.outputs).toEqual({ target_sha: sha, first_line: 'release: v1.2.3', is_release: 'true' });
  });

  it('squash / direct push with a non-release message: is_release=false', () => {
    git('checkout', '-q', 'main');
    const sha = commit('fix: something (#2000)');

    const r = detect(sha);
    expect(r.status).toBe(0);
    expect(r.outputs.is_release).toBe('false');
    expect(r.outputs.target_sha).toBe(sha);
  });

  it('workflow_dispatch recovery with the release commit sha itself works (non-merge path)', () => {
    const rel = git('log', '--format=%H', '--grep=^release: v0.8.15$', '-1', 'main');
    const r = detect(rel);
    expect(r.status).toBe(0);
    expect(r.outputs).toEqual({ target_sha: rel, first_line: 'release: v0.8.15', is_release: 'true' });
  });

  it('release/v* merge with no release commit FAILS with ::error::, never a green skip', () => {
    git('checkout', '-q', '-b', 'release/v2.0.0', 'main');
    commit('chore: forgot the release commit');
    git('checkout', '-q', 'main');
    const merge = mergePr('release/v2.0.0', 105);

    const r = detect(merge);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('::error::');
    expect(r.stdout).toContain('release/v2.0.0');
    expect(r.outputs).toEqual({});
  });

  it('release/v* merge whose release commit is beyond the bound FAILS', () => {
    git('checkout', '-q', '-b', 'release/v3.0.0', 'main');
    commit('release: v3.0.0');
    for (let i = 0; i < MAX_WALK; i++) commit(`noise ${i}`);
    git('checkout', '-q', 'main');
    const merge = mergePr('release/v3.0.0', 106);

    const r = detect(merge);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('::error::');
  });

  it('rejects a non-sha TARGET_SHA', () => {
    const r = spawnSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, TARGET_SHA: 'main; rm -rf /', DETECT_WORKDIR: dir, GIT_BIN: GIT },
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('::error::');
  });
});

// ── workflow wiring ──────────────────────────────────────────────────────────

describe('tag-release.yml wiring (#2685)', () => {
  const raw = readFileSync(WORKFLOW, 'utf8');
  const workflow = YAML.parse(raw);
  const step = workflow.jobs['tag-and-deploy'].steps.find((s) => s.id === 'check');

  it('uses the shared detection script for push and workflow_dispatch alike', () => {
    expect(step.run).toContain('node scripts/detect-release-commit.mjs');
    expect(step.run).toContain('workflow_dispatch');
  });

  it('passes values through env, never ${{ }} inside run:', () => {
    for (const s of workflow.jobs['tag-and-deploy'].steps) {
      expect(s.run ?? '').not.toContain('${{');
    }
    expect(step.env.DISPATCH_SHA).toBe('${{ inputs.sha }}');
  });

  it('keeps checkout pinned and full-history', () => {
    const checkout = workflow.jobs['tag-and-deploy'].steps[0];
    expect(checkout.uses).toBe('actions/checkout@v4');
    expect(checkout.with['fetch-depth']).toBe(0);
  });

  it('documents the recovery path in the header comment', () => {
    expect(raw).toContain('scripts/detect-release-commit.mjs');
    expect(raw).toMatch(/commit's own sha also works/);
  });
});
