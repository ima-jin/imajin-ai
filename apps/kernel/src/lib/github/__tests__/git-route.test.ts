import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { authority, read, sign, insert } = vi.hoisted(() => ({
  authority: vi.fn(), read: vi.fn(), sign: vi.fn(), insert: vi.fn(),
}));
vi.mock('../git-authority', () => ({ gitAuthority: authority }));
vi.mock('../connector', () => ({ readGitRepository: read }));
vi.mock('@/src/db', () => ({ db: { insert: () => ({ values: insert }) }, attestations: {} }));
vi.mock('@/src/lib/auth/emit-mechanical-attestation', () => ({ prepareMechanicalAttestation: sign }));
import { GET, POST } from '@/app/github/git/[...path]/route';

const request = () => new Request('https://kernel.test/github/git/ima-jin/private.git/info/refs?service=git-upload-pack');
beforeEach(() => {
  vi.resetAllMocks();
  authority.mockResolvedValue({ actorDid: 'did:imajin:agent', ownerDid: 'did:imajin:owner', grantId: 'grant' });
  sign.mockResolvedValue({ id: 'audit' });
  insert.mockResolvedValue(undefined);
  read.mockResolvedValue(new Response('0000'));
});

describe('kernel git route', () => {
  it('checks authorization and persists distinct actor/owner attribution before credential access', async () => {
    expect((await GET(request())).status).toBe(200);
    expect(sign).toHaveBeenCalledWith(expect.objectContaining({
      subjectDid: 'did:imajin:owner',
      payload: expect.objectContaining({ actorDid: 'did:imajin:agent', ownerDid: 'did:imajin:owner', grantId: 'grant' }),
    }));
    expect(read).toHaveBeenCalledWith('did:imajin:owner', expect.any(Request), expect.objectContaining({ repo: 'ima-jin/private' }));
    expect(insert.mock.invocationCallOrder[0]).toBeLessThan(read.mock.invocationCallOrder[0]);
    expect(POST).toBe(GET);
  });
  it.each([401, 403, 409])('does not read any credential for authority denial %s', async status => {
    authority.mockResolvedValue(status);
    expect((await GET(request())).status).toBe(status);
    expect(read).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
  });
  it('rejects push before credential loading', async () => {
    expect((await GET(new Request('https://kernel.test/github/git/ima-jin/private.git/info/refs?service=git-receive-pack'))).status).toBe(403);
    expect(authority).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });
  it.each(['authority', 'audit', 'credential'])('fails closed without logging or exposing raw %s errors', async stage => {
    const token = randomBytes(32).toString('hex');
    const logger = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const throwing = { authority, audit: insert, credential: read }[stage];
    throwing.mockRejectedValue(new Error(token));
    const response = await GET(request());
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain(token);
    expect(JSON.stringify([...response.headers])).not.toContain(token);
    expect(logger).not.toHaveBeenCalled();
    logger.mockRestore();
  });
});
