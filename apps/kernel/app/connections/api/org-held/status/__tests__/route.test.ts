import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ auth: vi.fn(), read: vi.fn() }));
vi.mock('@imajin/auth', () => ({ requireAuth: mocks.auth }));
vi.mock('@/src/lib/kernel/org-held-status', () => ({ readOrgHeldStatus: mocks.read }));
vi.mock('@/src/lib/kernel/cors', () => ({ corsHeaders: () => ({}), corsOptions: vi.fn() }));

import { GET } from '../route';

const orgDid = 'did:imajin:org';
const callerDid = 'did:imajin:caller';
const request = () => new NextRequest(`http://localhost/connections/api/org-held/status?orgDid=${orgDid}`);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.read.mockResolvedValue({ connections: [] });
});

describe('org-held status member authority', () => {
  it.each(['agent', 'presence'])('refuses a %s before reading org key status', async (subtype) => {
    mocks.auth.mockResolvedValue({ identity: { id: callerDid, subtype } });
    const response = await GET(request());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Organization member session required' });
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it('allows a human session using the org selector and original member DID', async () => {
    mocks.auth.mockResolvedValue({ identity: { id: callerDid, subtype: 'human' } });
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ connections: [] });
    expect(mocks.auth).toHaveBeenCalledWith(expect.any(Request), { sessionOnly: true });
    expect(mocks.read).toHaveBeenCalledWith({ actorDid: callerDid, orgDid });
  });
});
