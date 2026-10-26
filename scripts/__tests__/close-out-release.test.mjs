import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import YAML from 'yaml';
import { closeOutRelease, nextPatchMilestone } from '../close-out-release.mjs';
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

const tag = 'v0.8.27';
const repo = 'ima-jin/imajin-ai';
const base = `repos/${repo}`;
const source = { title: tag, state: 'open', number: 27 };
const next = { title: 'v0.8.28', state: 'open', number: 28 };
const missing = Object.assign(new Error('missing'), { stderr: 'release not found\n' });
const patchCalls = (gh) => gh.mock.calls.filter(([args]) => args.includes('PATCH'));

function fixture({ milestones = [[source, next]], items = [[]], releaseError, failItem } = {}) {
  const log = vi.fn();
  const gh = vi.fn((args) => {
    if (args[0] === 'release') {
      if (args[1] === 'view' && releaseError) throw releaseError;
      return '{}';
    }
    if (args.includes('PATCH')) {
      if (args.includes(`${base}/issues/${failItem}`)) throw new Error('HTTP 403');
      return '{}';
    }
    return JSON.stringify(args[1].includes('/milestones?') ? milestones : items);
  });
  return { gh, log, run: () => closeOutRelease({ tag, repo, gh, log }) };
}

describe('release milestone selection', () => {
  it('chooses the numerically lowest later open patch across gaps and unsorted pages', () => {
    expect(nextPatchMilestone('v0.8.9', [
      { title: 'v0.8.100', state: 'open' },
      { title: 'v0.8.11', state: 'open' },
      { title: 'v0.8.10', state: 'open' },
    ])).toMatchObject({ title: 'v0.8.10' });
  });

  it.each([
    ['v0.8.27', 'open'], ['v0.8.26', 'open'], ['v0.9.28', 'open'],
    ['v1.8.28', 'open'], ['v0.8.28', 'closed'], ['v0.8.28-rc1', 'open'],
    ['0.8.28', 'open'], ['v00.8.28', 'open'], ['v0.8.028', 'open'],
  ])('excludes ineligible milestone %s (%s)', (title, state) => {
    expect(nextPatchMilestone(tag, [{ title, state }])).toBeUndefined();
  });
});

describe('release close-out', () => {
  it('uses only the fixed system CLI, not an executable selected through PATH', () => {
    vi.mocked(execFileSync).mockReturnValueOnce('{}').mockReturnValueOnce('[]');
    closeOutRelease({ tag, repo, log: vi.fn() });
    expect(execFileSync).toHaveBeenCalledTimes(2);
    for (const [executable, , options] of vi.mocked(execFileSync).mock.calls) {
      expect(executable).toBe('/usr/bin/gh');
      expect(options).toEqual({ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    }
    vi.mocked(execFileSync).mockReset();
  });
  it('checks before creating a missing release with generated notes and an existing tag', () => {
    const f = fixture({ releaseError: missing });
    f.run();
    expect(f.gh.mock.calls.slice(0, 2)).toEqual([
      [['release', 'view', tag, '--repo', repo, '--json', 'tagName']],
      [['release', 'create', tag, '--repo', repo, '--verify-tag', '--generate-notes']],
    ]);
  });

  it('never recreates an existing release', () => {
    const f = fixture();
    f.run();
    expect(f.gh.mock.calls.some(([args]) => args[1] === 'create')).toBe(false);
  });

  it('moves every open issue AND PR before closing, including subsequent pages', () => {
    const f = fixture({
      milestones: [[source], [next]],
      items: [[{ number: 1 }], [{ number: 2, pull_request: { url: 'pr' } }]],
    });
    f.run();
    expect(f.gh).toHaveBeenCalledWith([
      'api', `${base}/milestones?state=all&per_page=100`, '--paginate', '--slurp',
    ]);
    expect(f.gh).toHaveBeenCalledWith([
      'api', `${base}/issues?milestone=27&state=open&per_page=100`, '--paginate', '--slurp',
    ]);
    expect(patchCalls(f.gh)).toEqual([
      [['api', '--method', 'PATCH', `${base}/issues/1`, '-F', 'milestone=28']],
      [['api', '--method', 'PATCH', `${base}/issues/2`, '-F', 'milestone=28']],
      [['api', '--method', 'PATCH', `${base}/milestones/27`, '-f', 'state=closed']],
    ]);
  });

  it.each([[], [{ ...source, state: 'closed' }, next]])(
    'is a no-op for missing or already closed milestone (%j)', (...milestones) => {
      const f = fixture({ milestones: [milestones] });
      f.run();
      expect(patchCalls(f.gh)).toEqual([]);
      expect(f.gh).toHaveBeenCalledTimes(2);
    },
  );

  it('warns without moving, closing, or creating milestones if no next patch exists', () => {
    const f = fixture({ milestones: [[source]] });
    f.run();
    expect(f.log).toHaveBeenCalledWith(expect.stringContaining('::warning::'));
    expect(f.gh).toHaveBeenCalledTimes(2);
  });

  it('closes an empty milestone when there is a next patch', () => {
    const f = fixture();
    f.run();
    expect(patchCalls(f.gh)).toHaveLength(1);
  });

  it('resumes a partially completed rollover, then a closed-milestone rerun makes no writes', () => {
    const f = fixture({ items: [[{ number: 2 }]] });
    f.run();
    expect(patchCalls(f.gh)).toHaveLength(2);
    const rerun = fixture({ milestones: [[{ ...source, state: 'closed' }, next]] });
    rerun.run();
    expect(patchCalls(rerun.gh)).toEqual([]);
  });

  it('does not close the milestone if any item move fails', () => {
    const f = fixture({ items: [[{ number: 1 }, { number: 2 }]], failItem: 2 });
    expect(f.run).toThrow('HTTP 403');
    expect(patchCalls(f.gh)).toHaveLength(2);
  });

  it.each(['HTTP 401', 'HTTP 403', 'HTTP 500', 'network unavailable'])(
    'fails closed on release lookup failure: %s', (message) => {
      const f = fixture({ releaseError: Object.assign(new Error(message), { stderr: message }) });
      expect(f.run).toThrow(message);
      expect(f.gh).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['', 'v0.8', 'v0.8.27; touch bad', 'v0.8.27-rc1', 'v00.8.27'])(
    'rejects invalid tag %j before calling GitHub', (invalid) => {
      const gh = vi.fn();
      expect(() => closeOutRelease({ tag: invalid, repo, gh })).toThrow('vX.Y.Z');
      expect(() => nextPatchMilestone(invalid, [])).toThrow('vX.Y.Z');
      expect(gh).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, '', '../repo', 'owner/repo/extra', 'owner/repo; command'])(
    'rejects invalid repository %j before calling GitHub', (invalid) => {
      const gh = vi.fn();
      expect(() => closeOutRelease({ tag, repo: invalid, gh })).toThrow('owner/repo');
      expect(gh).not.toHaveBeenCalled();
    },
  );

  it.each(['milestones', 'issues'])('propagates %s read errors without closing', (resource) => {
    const f = fixture();
    const original = f.gh.getMockImplementation();
    f.gh.mockImplementation((args) => {
      if (args[0] === 'api' && args[1].includes(`/${resource}?`)) throw new Error('HTTP 403');
      return original(args);
    });
    expect(f.run).toThrow('HTTP 403');
    expect(patchCalls(f.gh)).toEqual([]);
  });
});

describe('workflow and operator docs contract', () => {
  const workflow = YAML.parse(readFileSync(new URL('../../.github/workflows/tag-release.yml', import.meta.url), 'utf8'));
  const job = workflow.jobs['tag-and-deploy'];
  const step = job.steps.find((candidate) => candidate.run === 'node scripts/close-out-release.mjs');

  it('runs close-out automatically for releases after tagging, without new auth', () => {
    expect(step.if).toBe("steps.check.outputs.is_release == 'true'");
    expect(step.env).toEqual({
      GH_TOKEN: '${{ github.token }}', GH_REPO: '${{ github.repository }}',
      TAG: '${{ steps.version.outputs.tag }}',
    });
    expect(job.permissions).toEqual({ contents: 'write', issues: 'write', actions: 'write' });
    expect(job.steps.indexOf(step)).toBeGreaterThan(
      job.steps.findIndex((candidate) => candidate.name === 'Create the annotated tag (idempotent)'),
    );
  });

  it('preserves the existing automatic and recovery triggers', () => {
    expect(workflow.on.push).toEqual({ branches: ['main'] });
    expect(workflow.on.workflow_dispatch.inputs.sha.required).toBe(true);
  });

  it('documents automatic notes, rollover and the missing-next warning', () => {
    const docs = readFileSync(new URL('../../docs/npm-publishing.md', import.meta.url), 'utf8');
    expect(docs).toContain('Release close-out is automatic (#3093)');
    expect(docs).toContain('creates the GitHub Release with generated notes');
    expect(docs).toContain('moves open issues and PRs to the lowest open patch milestone');
    expect(docs).toContain('no next patch milestone means a warning with no close');
  });
});
