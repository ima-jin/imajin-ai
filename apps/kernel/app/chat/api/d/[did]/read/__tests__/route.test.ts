/**
 * Tests for POST /chat/api/d/:did/read — session caller authorization (#2145).
 *
 * Before this fix, any authenticated session could write a read-receipt row
 * for a conversation it was never part of, because the route called
 * `requireAuth` but never checked the caller against the conversation
 * itself (the same shape of gap #2136/#2138 fixed on PATCH .../context).
 * This mirrors that fix: `resolveActingDid` -> `checkAccess(effectiveDid,
 * did)` -> 403 `{ error: 'Access denied' }`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  checkAccess: vi.fn(),
  inserted: [] as Record<string, unknown>[],
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: h.requireAuth,
  resolveActingDid: (identity: { id: string; actingFor?: string; actingAs?: string }) =>
    identity.actingFor ?? identity.actingAs ?? identity.id,
}));

vi.mock('@/src/lib/kernel/access', () => ({ checkAccess: h.checkAccess }));

vi.mock('@/src/lib/kernel/cors', () => ({
  corsOptions: () => new Response(null, { status: 204 }),
  corsHeaders: () => ({}),
}));

vi.mock('@/src/db', () => ({
  db: {
    insert: (table: { name: string }) => ({
      values: (row: Record<string, unknown>) => ({
        onConflictDoUpdate: () => {
          h.inserted.push({ table: table.name, ...row });
          return Promise.resolve();
        },
      }),
    }),
  },
  conversationReadsV2: {
    name: 'conversation_reads_v2',
    conversationDid: 'conversationDid',
    did: 'did',
  },
}));

import { POST } from '../route';

const OWNER = 'did:imajin:owner';
const OUTSIDER = 'did:imajin:outsider';
const AGENT = 'did:imajin:agent';
const CONVERSATION_DID = 'did:imajin:dm:1234567890abcdef';

function post() {
  return POST({} as unknown as NextRequest, { params: Promise.resolve({ did: CONVERSATION_DID }) });
}

beforeEach(() => {
  h.inserted.splice(0);
  h.requireAuth.mockReset();
  h.checkAccess.mockReset();

  h.requireAuth.mockResolvedValue({ identity: { id: OWNER, tier: 'established' } });
  h.checkAccess.mockResolvedValue({ allowed: true });
});

describe('POST /chat/api/d/:did/read — session caller authorization (#2145)', () => {
  it('rejects an authenticated non-participant with 403 and never writes a read receipt', async () => {
    h.requireAuth.mockResolvedValue({ identity: { id: OUTSIDER, tier: 'established' } });
    h.checkAccess.mockResolvedValue({ allowed: false });

    const res = await post();

    expect(h.checkAccess).toHaveBeenCalledWith(OUTSIDER, CONVERSATION_DID);
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: 'Access denied' });
    expect(h.inserted).toHaveLength(0);
  });

  it('allows a participant/owner session caller and marks the conversation read', async () => {
    h.checkAccess.mockResolvedValue({ allowed: true, role: 'owner', governance: 'dm' });

    const res = await post();

    expect(h.checkAccess).toHaveBeenCalledWith(OWNER, CONVERSATION_DID);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(h.inserted).toContainEqual(
      expect.objectContaining({
        table: 'conversation_reads_v2',
        conversationDid: CONVERSATION_DID,
        did: OWNER,
      }),
    );
  });

  it('authorizes actingFor the subject DID against the delegated DID, not the agent DID', async () => {
    h.requireAuth.mockResolvedValue({
      identity: { id: AGENT, tier: 'established', actingFor: OWNER },
    });
    h.checkAccess.mockResolvedValue({ allowed: true, role: 'owner', governance: 'dm' });

    const res = await post();

    expect(h.checkAccess).toHaveBeenCalledWith(OWNER, CONVERSATION_DID);
    expect(res.status).toBe(200);
    expect(h.inserted).toContainEqual(
      expect.objectContaining({ conversationDid: CONVERSATION_DID, did: OWNER }),
    );
  });

  it('propagates the requireAuth failure before ever calling checkAccess', async () => {
    h.requireAuth.mockResolvedValue({ error: 'Unauthorized', status: 401 });

    const res = await post();

    expect(res.status).toBe(401);
    expect(h.checkAccess).not.toHaveBeenCalled();
    expect(h.inserted).toHaveLength(0);
  });
});
