import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ auth: vi.fn(), prepare: vi.fn(), adopt: vi.fn() }));
vi.mock('@imajin/auth', async importOriginal => ({
  ...await importOriginal<typeof import('@imajin/auth')>(),
  requireAuth: h.auth,
  authErrorResponse: (error: { error: string; status: number }) => Response.json(error, { status: error.status }),
}));
vi.mock('@/src/lib/auth/agent-adoption', async importOriginal => ({
  ...await importOriginal<typeof import('@/src/lib/auth/agent-adoption')>(),
  prepareAdoption: h.prepare, adoptAgent: h.adopt,
}));
// Avoid loading database/custody services when only testing the route contract.
vi.mock('@/src/db', () => ({}));
vi.mock('@/src/lib/vault/import-authority', () => ({}));
vi.mock('@/src/lib/auth/grants', () => ({}));
vi.mock('@/src/lib/auth/emit-mechanical-attestation', () => ({}));

import { POST } from '../route';
import { AdoptionError } from '@/src/lib/auth/agent-adoption';
const ORG = 'did:imajin:artifact';
const HUMAN = 'did:imajin:admin';
const AGENT = 'did:imajin:orphan';
const request = (body: unknown) => new Request('http://kernel.test/auth/api/agents/adopt', {
  method: 'POST', body: JSON.stringify(body),
}) as Parameters<typeof POST>[0];
const challenge = { action: 'challenge', agentDid: AGENT, capabilities: ['messages:write'] };
beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ identity: { id: HUMAN, actingAs: ORG, actingAsRole: 'admin' } });
  h.prepare.mockResolvedValue({ challengeId: 'adopt_1', challenge: 'bound-proof' });
  h.adopt.mockResolvedValue({ did: AGENT, publicKey: 'unchanged' });
});

describe('adoption route', () => {
  it('uses the acting org as owner and the human only as audit actor', async () => {
    const req = request({ ...challenge, orgDid: 'did:imajin:untrusted' });
    expect((await POST(req)).status).toBe(200);
    expect(h.auth).toHaveBeenCalledWith(req, { service: 'auth' });
    expect(h.prepare).toHaveBeenCalledWith({ actorDid: HUMAN, orgDid: ORG, agentDid: AGENT, capabilities: ['messages:write'] });
  });
  it('redeems only the stored challenge under the resolved principal', async () => {
    expect((await POST(request({ action: 'adopt', challengeId: 'adopt_1', signature: 'signed' }))).status).toBe(200);
    expect(h.adopt).toHaveBeenCalledWith({ actorDid: HUMAN, orgDid: ORG, challengeId: 'adopt_1', signature: 'signed' });
  });
  it.each([
    { error: 'Not authenticated', status: 401 },
    { identity: { id: HUMAN, actingFor: ORG } },
    { identity: { id: HUMAN, actingAs: ORG, actingAsRole: 'member' } },
    { identity: { id: AGENT, subtype: 'agent' } },
  ])('refuses auth boundary %j before challenge preparation', async auth => {
    h.auth.mockResolvedValue(auth);
    expect((await POST(request(challenge))).status).toBe('error' in auth ? 401 : 403);
    expect(h.prepare).not.toHaveBeenCalled();
  });
  it.each([
    { ...challenge, agentDid: 123 }, { ...challenge, agentDid: 'did:web:other' },
    { ...challenge, capabilities: [] }, { ...challenge, capabilities: [1] },
    { ...challenge, capabilities: 'messages:write' }, { ...challenge, capabilities: ['unknown:scope'] },
    { action: 'adopt' }, { action: 'adopt', challengeId: 3, signature: 'x' }, { action: 'other' },
  ])('rejects invalid adoption input %j', async body => {
    expect((await POST(request(body))).status).toBe(400);
    expect(h.prepare).not.toHaveBeenCalled();
    expect(h.adopt).not.toHaveBeenCalled();
  });
  it('refuses invalid JSON', async () => {
    expect((await POST(new Request('http://kernel.test', { method: 'POST', body: '{' }) as Parameters<typeof POST>[0])).status).toBe(400);
  });
  it.each([403, 409])('preserves proof/orphan refusal status %s', async status => {
    h.adopt.mockRejectedValueOnce(new AdoptionError('Refused', status));
    expect((await POST(request({ action: 'adopt', challengeId: 'adopt_1', signature: 'x' }))).status).toBe(status);
  });
  it('redacts unexpected errors', async () => {
    h.prepare.mockRejectedValueOnce(new Error('internal details'));
    const response = await POST(request(challenge));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Unable to adopt agent' });
  });
});
