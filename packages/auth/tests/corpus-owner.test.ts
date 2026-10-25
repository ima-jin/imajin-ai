import { describe, expect, it, vi } from 'vitest';
import { githubCorpusOwner, resolveCorpusDid } from '../src/corpus-owner';

describe('source corpus owner', () => {
  it('resolves all repositories in the same GitHub organization through identity', async () => {
    const identity = vi.fn(async () => 'did:imajin:org');
    expect(await resolveCorpusDid('github:IMA-JIN/imajin-ai', 'did:imajin:jin', identity)).toBe('did:imajin:org');
    expect(await resolveCorpusDid('github:ima-jin/events', 'did:imajin:ryan', identity)).toBe('did:imajin:org');
    expect(identity).toHaveBeenNthCalledWith(1, 'ima-jin');
  });
  it('leaves workspace ownership with its principal without identity calls', async () => {
    const identity = vi.fn();
    expect(await resolveCorpusDid('local:workspace/repo', 'did:imajin:principal', identity)).toBe('did:imajin:principal');
    expect(identity).not.toHaveBeenCalled();
  });
  it.each(['github:org', 'github:org/../x', 'github:org/..', 'github:org/repo?x', 'github:/repo'])('rejects malformed GitHub source %s', source => {
    expect(() => githubCorpusOwner(source)).toThrow('Invalid GitHub corpus source');
  });
  it('fails closed when identity resolution fails', async () => {
    await expect(resolveCorpusDid('github:ima-jin/imajin-ai', 'did:imajin:jin', async () => { throw new Error('offline'); })).rejects.toThrow('offline');
    await expect(resolveCorpusDid('local:workspace', '', vi.fn())).rejects.toThrow('principal DID');
  });
});
