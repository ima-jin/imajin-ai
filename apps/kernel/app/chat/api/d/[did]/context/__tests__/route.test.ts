/**
 * Tests for PATCH /chat/api/d/:did/context (#2136).
 *
 * The route accepts two disjoint callers: sibling apps authenticating with
 * `Authorization: Bearer AUTH_INTERNAL_API_KEY` (e.g. events syncing
 * `nameDisplayPolicy`), and a user session via `requireAuth`. Before this
 * fix, the session path never checked that the caller was actually a
 * participant/owner of `{did}`'s conversation — any authenticated session
 * could PATCH any conversation's context. These tests pin the fix: a
 * session caller is now authorized against the conversation via the same
 * `checkAccess` helper the sibling `/messages` routes already use, while the
 * internal-key path stays byte-for-byte equivalent.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  checkAccess: vi.fn(),
  updatedWhere: [] as unknown[],
  updatedSet: [] as unknown[],
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: h.requireAuth,
  resolveActingDid: (identity: { id: string; actingFor?: string; actingAs?: string }) =>
    identity.actingFor ?? identity.actingAs ?? identity.id,
}));

vi.mock('@/src/lib/kernel/access', () => ({ checkAccess: h.checkAccess }));

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ col, val }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
}));

vi.mock('@/src/db', () => ({
  db: {
    update: () => ({
      set: (values: unknown) => {
        h.updatedSet.push(values);
        return {
          where: (pred: unknown) => {
            h.updatedWhere.push(pred);
            return Promise.resolve();
          },
        };
      },
    }),
  },
  conversationsV2: { name: 'conversations_v2', did: 'did', context: 'context' },
}));

vi.mock('@/src/lib/kernel/cors', () => ({
  corsOptions: () => new Response(null, { status: 204 }),
  corsHeaders: () => ({}),
}));

import { PATCH } from '../route';

const OWNER = 'did:imajin:owner';
const OUTSIDER = 'did:imajin:outsider';
const AGENT = 'did:imajin:agent';
const CONVERSATION_DID = 'did:imajin:dm:1234567890abcdef';
const INTERNAL_KEY = 'test-internal-key';

function contextRequest(body: unknown, headers: Record<string, string> = {}) {
  const headerMap = new Headers(headers);
  return {
    headers: headerMap,
    json: () => Promise.resolve(body),
  } as unknown as NextRequest;
}

function patch(body: unknown, headers: Record<string, string> = {}) {
  return PATCH(contextRequest(body, headers), { params: Promise.resolve({ did: CONVERSATION_DID }) });
}

beforeEach(() => {
  h.updatedWhere.splice(0);
  h.updatedSet.splice(0);
  h.requireAuth.mockReset();
  h.checkAccess.mockReset();
  process.env.AUTH_INTERNAL_API_KEY = INTERNAL_KEY;

  h.requireAuth.mockResolvedValue({ identity: { id: OWNER, tier: 'established' } });
  h.checkAccess.mockResolvedValue({ allowed: true });
});

describe('PATCH /chat/api/d/:did/context — session caller authorization (#2136)', () => {
  it('allows a participant/owner session caller and merges the context', async () => {
    h.checkAccess.mockResolvedValue({ allowed: true, role: 'owner', governance: 'dm' });

    const res = await patch({ context: { nameDisplayPolicy: 'handle' } });

    expect(h.checkAccess).toHaveBeenCalledWith(OWNER, CONVERSATION_DID);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ success: true });
    expect(h.updatedWhere).toHaveLength(1);
  });

  it('rejects an authenticated non-participant with 403 and does not mutate the context', async () => {
    h.requireAuth.mockResolvedValue({ identity: { id: OUTSIDER, tier: 'established' } });
    h.checkAccess.mockResolvedValue({ allowed: false });

    const res = await patch({ context: { nameDisplayPolicy: 'handle' } });

    expect(h.checkAccess).toHaveBeenCalledWith(OUTSIDER, CONVERSATION_DID);
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: 'Access denied' });
    expect(h.updatedWhere).toHaveLength(0);
  });

  it('authorizes actingFor the subject DID against the delegated DID, not the agent DID', async () => {
    h.requireAuth.mockResolvedValue({
      identity: { id: AGENT, tier: 'established', actingFor: OWNER },
    });
    h.checkAccess.mockResolvedValue({ allowed: true, role: 'owner', governance: 'dm' });

    const res = await patch({ context: { nameDisplayPolicy: 'handle' } });

    expect(h.checkAccess).toHaveBeenCalledWith(OWNER, CONVERSATION_DID);
    expect(res.status).toBe(200);
  });

  it('propagates the requireAuth failure before ever calling checkAccess', async () => {
    h.requireAuth.mockResolvedValue({ error: 'Unauthorized', status: 401 });

    const res = await patch({ context: { nameDisplayPolicy: 'handle' } });

    expect(res.status).toBe(401);
    expect(h.checkAccess).not.toHaveBeenCalled();
    expect(h.updatedWhere).toHaveLength(0);
  });
});

describe('PATCH /chat/api/d/:did/context — internal API key path (unchanged)', () => {
  it('allows the internal key without ever checking requireAuth or checkAccess', async () => {
    const res = await patch(
      { context: { nameDisplayPolicy: 'handle' } },
      { authorization: `Bearer ${INTERNAL_KEY}` },
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ success: true });
    expect(h.requireAuth).not.toHaveBeenCalled();
    expect(h.checkAccess).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing key', {}],
    ['the wrong key', { authorization: 'Bearer wrong-key' }],
  ])('falls through to the session path (and its authz gate) for %s', async (_label, headers) => {
    h.checkAccess.mockResolvedValue({ allowed: false });

    const res = await patch({ context: { nameDisplayPolicy: 'handle' } }, headers);

    expect(h.requireAuth).toHaveBeenCalled();
    expect(res.status).toBe(403);
  });
});

describe('PATCH /chat/api/d/:did/context — request body validation', () => {
  it('returns 400 for invalid JSON', async () => {
    const request = {
      headers: new Headers({ authorization: `Bearer ${INTERNAL_KEY}` }),
      json: () => Promise.reject(new Error('bad json')),
    } as unknown as NextRequest;

    const res = await PATCH(request, { params: Promise.resolve({ did: CONVERSATION_DID }) });

    expect(res.status).toBe(400);
  });

  it('returns 400 when context is missing', async () => {
    const res = await patch({}, { authorization: `Bearer ${INTERNAL_KEY}` });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'context object is required' });
  });
});
