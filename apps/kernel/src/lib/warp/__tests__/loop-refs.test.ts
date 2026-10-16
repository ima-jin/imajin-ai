import { describe, expect, it } from 'vitest';
import { githubLoopRef, warpRunLoopRefs, warpRunPrArtifacts } from '../loop-refs';

const base = { runId: 'run', sessionId: 'session', triggerUrl: null, artifacts: [] };
const artifact = (url: string) => ({ artifactType: 'PULL_REQUEST', createdAt: null, data: { url } });

describe('Warp loop refs', () => {
  it('extracts every distinct typed PR artifact, excluding unrelated prose', () => {
    expect(warpRunPrArtifacts({ artifacts: [
      artifact('https://github.com/o/r/pull/1'), artifact('https://github.com/o/r/pull/1#comment'),
      artifact('https://github.com/o/r/pull/2'),
      { artifactType: 'TEXT', createdAt: null, data: { url: 'https://github.com/o/r/pull/3' } },
      artifact('https://invalid.example/o/r/pull/4'),
    ] })).toEqual(['https://github.com/o/r/pull/1', 'https://github.com/o/r/pull/2']);
  });
  it('uses confirmed run metadata and typed artifact URLs', () => {
    expect(warpRunLoopRefs({
      ...base, triggerUrl: 'https://github.com/ima-jin/imajin-ai/issues/2290',
      artifacts: [artifact('https://github.com/ima-jin/imajin-ai/pull/2300#discussion')],
    })).toEqual({
      runId: 'run', sessionKey: 'session', issue: 'https://github.com/ima-jin/imajin-ai/issues/2290',
      pr: 'https://github.com/ima-jin/imajin-ai/pull/2300',
    });
  });
  it('does not choose an arbitrary PR when multiple distinct artifacts exist', () => {
    expect(warpRunLoopRefs({ ...base, artifacts: [artifact('https://github.com/o/r/pull/1'), artifact('https://github.com/o/r/pull/2')] }).pr).toBeUndefined();
  });
  it('deduplicates PR artifacts and prefers explicit trigger metadata', () => {
    expect(warpRunLoopRefs({ ...base, artifacts: [artifact('https://github.com/o/r/pull/1'), artifact('https://github.com/o/r/pull/1')] }).pr).toBe('https://github.com/o/r/pull/1');
    expect(warpRunLoopRefs({ ...base, triggerUrl: 'https://github.com/o/r/pull/3', artifacts: [artifact('https://github.com/o/r/pull/1')] }).pr).toBe('https://github.com/o/r/pull/3');
  });
  it('omits unknown metadata and ignores unrelated artifact prose', () => {
    expect(warpRunLoopRefs({
      ...base, sessionId: null, triggerUrl: 'https://linear.app/team/issue/X',
      artifacts: [{ artifactType: 'TEXT', createdAt: null, data: { url: 'https://github.com/o/r/pull/1', branch: 'fix/2290' } }],
    })).toEqual({ runId: 'run' });
  });
  it.each([undefined, 1, 'not a URL', 'http://github.com/o/r/pull/1', 'https://github.com.evil.test/o/r/pull/1', 'https://user:pass@github.com/o/r/pull/1', 'https://github.com/o/r/pull/1/files', 'https://github.com/o/r/pull/0'])('rejects untrustworthy entity URL %s', (url) => {
    expect(githubLoopRef(url, 'pull')).toBeUndefined();
  });
});
