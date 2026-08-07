/**
 * Tests for /chat/api/conversations (#1649, #855).
 *
 * The DM guard and connection check are unit-tested in their own suites; here
 * they are stubbed so these tests can assert the ROUTE's contract: which branch
 * returns which status, that a new DM thread is gated on an active connection,
 * and that an existing thread is returned rather than duplicated.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  conversations: [] as Record<string, unknown>[],
  inserted: [] as Record<string, unknown>[],
  rawSqlValues: [] as unknown[][],
  canInitiateDm: vi.fn(),
  listConversations: vi.fn(),
  requireAuth: vi.fn(),
  requireGraphMember: vi.fn(),
  resolveEffectiveDid: vi.fn(),
  publish: vi.fn(),
  logError: vi.fn(),
}));

// Passthrough: the wrapper's logging/correlation behaviour is not under test.
vi.mock('@imajin/logger', () => ({
  withLogger:
    (_service: string, handler: (req: unknown, ctx: unknown) => Promise<Response>) =>
    (req: unknown) =>
      handler(req, { log: { error: h.logError, info: vi.fn() }, correlationId: 'cor_test' }),
}));

vi.mock('@imajin/bus', () => ({ publish: h.publish }));

vi.mock('@imajin/db', () => ({
  getClient: () => (_strings: TemplateStringsArray, ...values: unknown[]) => {
    h.rawSqlValues.push(values);
    return Promise.resolve();
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ col, val }),
}));

vi.mock('@/src/db', () => ({
  db: {
    query: {
      conversationsV2: {
        findFirst: ({ where }: { where: { val: string } }) =>
          Promise.resolve(h.conversations.find((c) => c.did === where.val)),
      },
    },
    insert: (table: { name: string }) => ({
      values: (row: Record<string, unknown>) => ({
        onConflictDoNothing: () => {
          h.inserted.push({ table: table.name, ...row });
          // Mirror the real insert so the route's follow-up read finds the row.
          if (table.name === 'conversations_v2') h.conversations.push(row);
          return Promise.resolve();
        },
      }),
    }),
  },
  conversationsV2: { name: 'conversations_v2', did: 'did' },
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: h.requireAuth,
  resolveEffectiveDid: h.resolveEffectiveDid,
  resolveActingDid: (identity: { id: string }) => identity.id,
}));

vi.mock('@/src/lib/kernel/require-graph-member', () => ({
  requireGraphMember: h.requireGraphMember,
}));

vi.mock('@/src/lib/chat/connection-check', () => ({
  canInitiateDm: h.canInitiateDm,
  DM_CONNECTION_REQUIRED: 'You must be connected to message this person',
}));

vi.mock('@/src/lib/chat/queries', () => ({ listConversations: h.listConversations }));

import { GET, POST } from '../route';
import { dmDid } from '@/src/lib/chat/conversation-did';

const ALICE = 'did:imajin:alice';
const BOB = 'did:imajin:bob';
const CAROL = 'did:imajin:carol';

function postRequest(body: unknown): NextRequest {
  return { json: () => Promise.resolve(body) } as unknown as NextRequest;
}

beforeEach(() => {
  h.conversations.splice(0);
  h.inserted.splice(0);
  h.rawSqlValues.splice(0);
  h.canInitiateDm.mockReset();
  h.listConversations.mockReset();
  h.requireAuth.mockReset();
  h.requireGraphMember.mockReset();
  h.resolveEffectiveDid.mockReset();
  h.logError.mockReset();
  h.publish.mockResolvedValue(undefined);

  h.requireAuth.mockResolvedValue({ identity: { id: ALICE } });
  h.requireGraphMember.mockResolvedValue({ identity: { id: ALICE } });
  h.resolveEffectiveDid.mockResolvedValue({ ok: true, effectiveDid: ALICE });
});

describe('GET /chat/api/conversations', () => {
  it('propagates the auth failure status', async () => {
    h.resolveEffectiveDid.mockResolvedValue({ ok: false, error: 'Unauthorized', status: 401 });

    const res = await GET({} as NextRequest);

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(h.listConversations).not.toHaveBeenCalled();
  });

  it('returns the caller-scoped conversation list', async () => {
    h.listConversations.mockResolvedValue([{ did: 'did:imajin:dm:abc' }]);

    const res = await GET({} as NextRequest);

    expect(h.listConversations).toHaveBeenCalledWith(ALICE);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ conversations: [{ did: 'did:imajin:dm:abc' }] });
  });

  it('answers 500 when the listing query fails', async () => {
    h.listConversations.mockRejectedValue(new Error('db down'));

    const res = await GET({} as NextRequest);

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: 'Failed to list conversations' });
    expect(h.logError).toHaveBeenCalled();
  });
});

describe('POST /chat/api/conversations — validation', () => {
  it.each([
    [undefined, 'type must be "direct" or "group"'],
    ['broadcast', 'type must be "direct" or "group"'],
  ])('rejects type %s', async (type, error) => {
    const res = await POST(postRequest({ type }));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error });
  });

  it('propagates a graph-membership denial for direct conversations', async () => {
    h.requireGraphMember.mockResolvedValue({ error: 'Not a graph member', status: 403 });

    const res = await POST(postRequest({ type: 'direct', participantDids: [BOB] }));

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: 'Not a graph member' });
  });

  it('requires a non-empty participantDids array', async () => {
    const res = await POST(postRequest({ type: 'direct', participantDids: [] }));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'participantDids is required' });
  });

  it('rejects a malformed participant DID', async () => {
    const res = await POST(postRequest({ type: 'direct', participantDids: ['not-a-did'] }));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'Invalid DID: not-a-did' });
  });

  it('requires exactly one other participant for a direct conversation', async () => {
    const res = await POST(postRequest({ type: 'direct', participantDids: [BOB, CAROL] }));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: 'Direct conversations must have exactly one other participant',
    });
  });

  it('answers 500 when the body is not JSON', async () => {
    const res = await POST({ json: () => Promise.reject(new Error('bad json')) } as unknown as NextRequest);

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: 'Failed to create conversation' });
  });
});

describe('POST /chat/api/conversations — direct (#855 connection gate)', () => {
  it('returns the existing thread without re-checking the gate', async () => {
    h.conversations.push({ did: dmDid(ALICE, BOB), type: 'dm' });

    const res = await POST(postRequest({ type: 'direct', participantDids: [BOB] }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ existing: true });
    expect(h.canInitiateDm).not.toHaveBeenCalled();
    expect(h.inserted).toHaveLength(0);
  });

  it('refuses to open a new thread when the pair is not connected', async () => {
    h.canInitiateDm.mockResolvedValue(false);

    const res = await POST(postRequest({ type: 'direct', participantDids: [BOB] }));

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      error: 'You must be connected to message this person',
    });
    expect(h.inserted).toHaveLength(0);
    expect(h.publish).not.toHaveBeenCalled();
  });

  it('creates the canonical thread and records both members when connected', async () => {
    h.canInitiateDm.mockResolvedValue(true);

    const res = await POST(postRequest({ type: 'direct', participantDids: [BOB] }));

    expect(h.canInitiateDm).toHaveBeenCalledWith(ALICE, BOB);
    expect(res.status).toBe(201);
    // The thread key is the order-independent pair hash, not the raw person DID.
    expect(h.inserted).toContainEqual(
      expect.objectContaining({ did: dmDid(ALICE, BOB), type: 'dm', createdBy: ALICE }),
    );
    // One VALUES tuple per party, so the thread DID is interpolated twice.
    expect(h.rawSqlValues.at(0)).toEqual([dmDid(ALICE, BOB), ALICE, dmDid(ALICE, BOB), BOB]);
    expect(h.publish).toHaveBeenCalledWith(
      'conversation.create',
      expect.objectContaining({
        payload: { conversationDid: dmDid(ALICE, BOB), type: 'direct' },
        correlationId: 'cor_test',
      }),
    );
  });
});

describe('POST /chat/api/conversations — group', () => {
  it('requires a name', async () => {
    const res = await POST(postRequest({ type: 'group', participantDids: [BOB] }));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'Group conversations require a name' });
  });

  it('creates a room-keyed thread with the creator deduped into the member set', async () => {
    const res = await POST(
      postRequest({ type: 'group', name: 'Studio', participantDids: [ALICE, BOB, CAROL] }),
    );

    expect(res.status).toBe(201);
    const created = h.inserted.find((r) => r.table === 'conversations_v2');
    expect(created).toMatchObject({ type: 'group', name: 'Studio', createdBy: ALICE });
    // Group identity is the room, not the members.
    expect(String(created?.did)).toMatch(/^did:imajin:group:[0-9a-f]{16}$/);
    // ALICE appears once despite being both creator and listed participant.
    expect(h.rawSqlValues.at(0)?.at(1)).toEqual([ALICE, BOB, CAROL]);
    expect(h.publish).toHaveBeenCalledWith(
      'conversation.create',
      expect.objectContaining({ scope: 'chat' }),
    );
  });
});
