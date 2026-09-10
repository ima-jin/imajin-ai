/**
 * Tests for GET /chat/api/d/:did/members — session caller authorization (#2145).
 *
 * Before this fix, any authenticated session could list the membership
 * (DIDs, names, handles) of ANY conversation — including private DMs and
 * groups the caller was never part of — because the route called
 * `requireAuth` but never checked the caller against the conversation
 * itself. This mirrors the #2136/#2138 fix on PATCH .../context: gate the
 * session path with `resolveActingDid` -> `checkAccess(effectiveDid, did)`
 * -> 403 `{ error: 'Access denied' }`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  checkAccess: vi.fn(),
  lookupIdentity: vi.fn(),
  memberRows: [] as Record<string, unknown>[],
  sqlCallCount: 0,
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@imajin/bus', () => ({ publish: vi.fn() }));

vi.mock('@imajin/auth', () => ({
  requireAuth: h.requireAuth,
  resolveActingDid: (identity: { id: string; actingFor?: string; actingAs?: string }) =>
    identity.actingFor ?? identity.actingAs ?? identity.id,
}));

vi.mock('@imajin/db', () => ({
  getClient: () => (_strings: TemplateStringsArray, ..._values: unknown[]) => {
    h.sqlCallCount += 1;
    return Promise.resolve(h.memberRows);
  },
}));

vi.mock('@/src/lib/kernel/access', () => ({ checkAccess: h.checkAccess }));
vi.mock('@/src/lib/kernel/lookup', () => ({ lookupIdentity: h.lookupIdentity }));

vi.mock('@/src/lib/kernel/cors', () => ({
  corsOptions: () => new Response(null, { status: 204 }),
  corsHeaders: () => ({}),
}));

import { GET } from '../route';

const OWNER = 'did:imajin:owner';
const OUTSIDER = 'did:imajin:outsider';
const AGENT = 'did:imajin:agent';
const CONVERSATION_DID = 'did:imajin:dm:1234567890abcdef';

function get() {
  return GET({} as unknown as NextRequest, { params: Promise.resolve({ did: CONVERSATION_DID }) });
}

beforeEach(() => {
  h.sqlCallCount = 0;
  h.memberRows = [{ did: OWNER, role: 'owner' }];
  h.requireAuth.mockReset();
  h.checkAccess.mockReset();
  h.lookupIdentity.mockReset();

  h.requireAuth.mockResolvedValue({ identity: { id: OWNER, tier: 'established' } });
  h.checkAccess.mockResolvedValue({ allowed: true });
  h.lookupIdentity.mockResolvedValue(null);
});

describe('GET /chat/api/d/:did/members — session caller authorization (#2145)', () => {
  it('rejects an authenticated non-participant with 403 and never queries membership', async () => {
    h.requireAuth.mockResolvedValue({ identity: { id: OUTSIDER, tier: 'established' } });
    h.checkAccess.mockResolvedValue({ allowed: false });

    const res = await get();

    expect(h.checkAccess).toHaveBeenCalledWith(OUTSIDER, CONVERSATION_DID);
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: 'Access denied' });
    expect(h.sqlCallCount).toBe(0);
  });

  it('allows a participant/owner session caller and returns the member list', async () => {
    h.checkAccess.mockResolvedValue({ allowed: true, role: 'owner', governance: 'dm' });

    const res = await get();

    expect(h.checkAccess).toHaveBeenCalledWith(OWNER, CONVERSATION_DID);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      members: [{ did: OWNER, role: 'owner', name: null, handle: null }],
      count: 1,
    });
  });

  it('authorizes actingFor the subject DID against the delegated DID, not the agent DID', async () => {
    h.requireAuth.mockResolvedValue({
      identity: { id: AGENT, tier: 'established', actingFor: OWNER },
    });
    h.checkAccess.mockResolvedValue({ allowed: true, role: 'owner', governance: 'dm' });

    const res = await get();

    expect(h.checkAccess).toHaveBeenCalledWith(OWNER, CONVERSATION_DID);
    expect(res.status).toBe(200);
  });

  it('propagates the requireAuth failure before ever calling checkAccess', async () => {
    h.requireAuth.mockResolvedValue({ error: 'Unauthorized', status: 401 });

    const res = await get();

    expect(res.status).toBe(401);
    expect(h.checkAccess).not.toHaveBeenCalled();
    expect(h.sqlCallCount).toBe(0);
  });
});
