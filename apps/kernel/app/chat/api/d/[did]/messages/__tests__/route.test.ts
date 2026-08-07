/**
 * Tests for POST /chat/api/d/:did/messages (#1649, #855).
 *
 * The guard itself is unit-tested in dm-guard.test.ts. What matters here is the
 * route's wiring: the URL param is a REQUEST, not a destination — every write
 * and every access check downstream must use the DID the guard resolved. A test
 * that let the raw param through would still pass the old code, so each
 * assertion below pins the canonical DID explicitly.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => {
  // Rows the fake drizzle `select()` chain hands back, keyed by table. Tests
  // rewrite these in place so a GET can be driven from the same mock a POST
  // uses.
  const rows: Record<string, Record<string, unknown>[]> = {
    messages_v2: [],
    message_reactions_v2: [],
    identities: [{ id: 'did:imajin:alice', subtype: 'human' }],
  };

  // Built as flat steps rather than a nested literal: the drizzle select chain
  // is four calls deep, which trips sonarjs/no-nested-functions when inlined.
  // The chain object is also thenable, because GET awaits some links directly
  // (`.where(...)`) and others only after `.orderBy(...).limit(...)`.
  const chain = (table: string): PromiseLike<unknown[]> =>
    Object.assign(Promise.resolve(rows[table] ?? []), {
      where: () => chain(table),
      orderBy: () => chain(table),
      limit: () => chain(table),
    });
  const from = (table: { name: string }) => chain(table.name);

  return {
    rows,
    resolveDmConversationTarget: vi.fn(),
    checkAccess: vi.fn(),
    ensureConversation: vi.fn(),
    ensureDmMembers: vi.fn(),
    triggerLinkUnfurl: vi.fn(),
    processMentions: vi.fn(),
    notifyMessageRecipients: vi.fn(),
    publish: vi.fn(),
    requireAuth: vi.fn(),
    inserted: [] as Record<string, unknown>[],
    updatedWhere: [] as unknown[],
    selectChain: () => ({ from }),
  };
});

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@imajin/bus', () => ({ publish: h.publish }));

// The delegation helpers are unit-tested in packages/auth/tests/acting-did.test.ts;
// these stubs only need to reproduce the precedence so the route's wiring is
// what is under test here.
vi.mock('@imajin/auth', () => ({
  requireAuth: h.requireAuth,
  isVerifiedTier: (tier?: string) => tier !== 'soft',
  canonicalize: (v: unknown) => JSON.stringify(v),
  crypto: { signSync: () => 'sig' },
  resolveActingDid: (identity: { id: string; actingFor?: string; actingAs?: string }) =>
    identity.actingFor ?? identity.actingAs ?? identity.id,
  resolveComposedBy: (identity: { id: string; actingFor?: string }) =>
    identity.actingFor && identity.actingFor !== identity.id ? identity.id : null,
}));

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ col, val }),
  and: (...preds: unknown[]) => ({ preds }),
  desc: (col: unknown) => col,
  lt: (col: unknown, val: unknown) => ({ col, val }),
  isNull: (col: unknown) => ({ col }),
  inArray: (col: unknown, vals: unknown) => ({ col, vals }),
}));

// `findFirst` re-reads the row the route just wrote, so a response assertion
// pins the read path rather than a hard-coded fixture.
function lastInsertedMessage() {
  const row = h.inserted.filter((r) => r.table === 'messages_v2').at(-1);
  if (!row) return { id: 'msg_1', content: { text: 'hi' } };
  // `table` is bookkeeping for the fake insert, not part of the stored row.
  return Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'table'));
}

vi.mock('@/src/db', () => ({
  db: {
    query: {
      messagesV2: { findFirst: () => Promise.resolve(lastInsertedMessage()) },
    },
    insert: (table: { name: string }) => ({
      values: (row: Record<string, unknown>) => {
        h.inserted.push({ table: table.name, ...row });
        return Promise.resolve();
      },
    }),
    update: () => ({
      set: () => ({
        where: (pred: unknown) => {
          h.updatedWhere.push(pred);
          return Promise.resolve();
        },
      }),
    }),
    select: h.selectChain,
  },
  conversationsV2: { name: 'conversations_v2', did: 'did' },
  messagesV2: { name: 'messages_v2', id: 'id', conversationDid: 'conversationDid', fromDid: 'fromDid' },
  messageReactionsV2: { name: 'message_reactions_v2', messageId: 'messageId' },
  identities: { name: 'identities', id: 'id', subtype: 'subtype' },
}));

vi.mock('@/src/lib/kernel/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/src/lib/kernel/utils')>()),
  generateId: () => 'msg_1',
}));

vi.mock('@/src/lib/kernel/cors', () => ({
  corsOptions: () => new Response(null, { status: 204 }),
  corsHeaders: () => ({}),
}));

vi.mock('@/src/lib/kernel/access', () => ({ checkAccess: h.checkAccess }));
vi.mock('@/src/lib/auth/dfos', () => ({ getChainByImajinDid: vi.fn().mockResolvedValue(null) }));
vi.mock('@imajin/dfos', () => ({ verifyChain: vi.fn() }));
vi.mock('@/src/lib/chat/mentions', () => ({ processMentions: h.processMentions }));
vi.mock('@/src/lib/chat/notify-message', () => ({ notifyMessageRecipients: h.notifyMessageRecipients }));
vi.mock('@/src/lib/chat/dm-guard', () => ({
  resolveDmConversationTarget: h.resolveDmConversationTarget,
}));
vi.mock('@/src/lib/chat/message-helpers', () => ({
  ensureConversation: h.ensureConversation,
  ensureDmMembers: h.ensureDmMembers,
  resolvePreviewText: (content: unknown) =>
    typeof content === 'object' && content !== null && 'text' in content
      ? String((content as { text: unknown }).text)
      : '',
  triggerLinkUnfurl: h.triggerLinkUnfurl,
}));

import { GET, POST } from '../route';

const ALICE = 'did:imajin:alice';
const BOB = 'did:imajin:bob';
const JIN = 'did:imajin:jin';
const CANONICAL = 'did:imajin:dm:1234567890abcdef';

function messageRequest(body: unknown) {
  return {
    request: { json: () => Promise.resolve(body) } as unknown as NextRequest,
    context: { params: Promise.resolve({ did: BOB }) },
  };
}

async function post(body: unknown) {
  const { request, context } = messageRequest(body);
  return POST(request, context);
}

beforeEach(() => {
  h.inserted.splice(0);
  h.updatedWhere.splice(0);
  h.rows.messages_v2 = [];
  h.rows.message_reactions_v2 = [];
  h.rows.identities = [{ id: ALICE, subtype: 'human' }];
  h.resolveDmConversationTarget.mockReset();
  h.checkAccess.mockReset();
  h.ensureConversation.mockReset();
  h.ensureDmMembers.mockReset();
  h.triggerLinkUnfurl.mockReset();
  h.requireAuth.mockReset();

  h.requireAuth.mockResolvedValue({ identity: { id: ALICE, tier: 'established', handle: 'alice' } });
  h.checkAccess.mockResolvedValue({ allowed: true });
  h.ensureConversation.mockResolvedValue(CANONICAL);
  h.ensureDmMembers.mockResolvedValue(undefined);
  h.publish.mockResolvedValue(undefined);
  h.resolveDmConversationTarget.mockResolvedValue({
    ok: true,
    conversationDid: CANONICAL,
    exists: false,
  });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
});

describe('POST /chat/api/d/:did/messages — auth and tier', () => {
  it('propagates the auth failure', async () => {
    h.requireAuth.mockResolvedValue({ error: 'Unauthorized', status: 401 });

    const res = await post({ content: { type: 'text', text: 'hi' } });

    expect(res.status).toBe(401);
    expect(h.resolveDmConversationTarget).not.toHaveBeenCalled();
  });

  it('refuses a soft DID before it can reach the guard', async () => {
    h.requireAuth.mockResolvedValue({ identity: { id: ALICE, tier: 'soft' } });

    const res = await post({ content: { type: 'text', text: 'hi' } });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      error: 'Please verify your account to send messages',
    });
    expect(h.resolveDmConversationTarget).not.toHaveBeenCalled();
  });
});

describe('POST /chat/api/d/:did/messages — DM guard (#1649, #855)', () => {
  it('passes the raw URL param to the guard as a request, not a destination', async () => {
    await post({ content: { type: 'text', text: 'hi' }, recipientDid: BOB });

    expect(h.resolveDmConversationTarget).toHaveBeenCalledWith({
      conversationDid: BOB,
      senderDid: ALICE,
      recipientDid: BOB,
    });
  });

  it('returns the guard verdict verbatim when it refuses', async () => {
    h.resolveDmConversationTarget.mockResolvedValue({
      ok: false,
      status: 403,
      error: 'You must be connected to message this person',
    });

    const res = await post({ content: { type: 'text', text: 'hi' } });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      error: 'You must be connected to message this person',
    });
    // Nothing downstream of the gate may run.
    expect(h.checkAccess).not.toHaveBeenCalled();
    expect(h.ensureConversation).not.toHaveBeenCalled();
    expect(h.inserted).toHaveLength(0);
  });

  it('checks access against the resolved DID, not the requested one', async () => {
    h.checkAccess.mockResolvedValue({ allowed: false });

    const res = await post({ content: { type: 'text', text: 'hi' } });

    expect(h.checkAccess).toHaveBeenCalledWith(ALICE, CANONICAL);
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: 'Access denied' });
    expect(h.inserted).toHaveLength(0);
  });

  it('writes the message to the resolved DID and forwards the recipient downstream', async () => {
    const res = await post({ content: { type: 'text', text: 'hi' }, recipientDid: BOB });

    expect(res.status).toBe(201);
    expect(h.ensureConversation).toHaveBeenCalledWith(CANONICAL, ALICE, null, BOB);
    expect(h.ensureDmMembers).toHaveBeenCalledWith(CANONICAL, ALICE, BOB);
    expect(h.inserted).toContainEqual(
      expect.objectContaining({
        table: 'messages_v2',
        conversationDid: CANONICAL,
        fromDid: ALICE,
      }),
    );
    expect(h.publish).toHaveBeenCalledWith(
      'message.send',
      expect.objectContaining({ payload: { conversationDid: CANONICAL, messageId: 'msg_1' } }),
    );
  });

  it('defaults a missing recipientDid to null rather than undefined', async () => {
    await post({ content: { type: 'text', text: 'hi' } });

    expect(h.resolveDmConversationTarget).toHaveBeenCalledWith(
      expect.objectContaining({ recipientDid: null }),
    );
    expect(h.ensureConversation).toHaveBeenCalledWith(CANONICAL, ALICE, null, null);
  });
});

describe('POST /chat/api/d/:did/messages — content validation', () => {
  it.each([
    [undefined, 'content is required and must be an object'],
    ['plain string', 'content is required and must be an object'],
  ])('rejects content %s', async (content, error) => {
    const res = await post({ content });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error });
  });

  it('rejects an unknown contentType', async () => {
    const res = await post({ content: { type: 'text' }, contentType: 'hologram' });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'Invalid contentType: hologram' });
  });

  it('answers 500 when the body is not JSON', async () => {
    const res = await POST(
      { json: () => Promise.reject(new Error('bad json')) } as unknown as NextRequest,
      { params: Promise.resolve({ did: BOB }) },
    );

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: 'Failed to send message' });
  });
});

describe('POST /chat/api/d/:did/messages — composedBy attribution (#1673)', () => {
  it('records the acting agent as composer while the human keeps fromDid', async () => {
    // Jin (the agent) authenticates and presents X-Acting-For: Alice.
    h.requireAuth.mockResolvedValue({
      identity: { id: JIN, tier: 'established', handle: 'jin', actingFor: ALICE, actingForRole: 'agent' },
    });

    const res = await post({ content: { type: 'text', text: 'hi' }, recipientDid: BOB });

    expect(res.status).toBe(201);
    expect(h.inserted).toContainEqual(
      expect.objectContaining({ table: 'messages_v2', fromDid: ALICE, composedBy: JIN }),
    );
  });

  it('returns composedBy on the created message', async () => {
    h.requireAuth.mockResolvedValue({
      identity: { id: JIN, tier: 'established', handle: 'jin', actingFor: ALICE, actingForRole: 'agent' },
    });

    const res = await post({ content: { type: 'text', text: 'hi' } });

    const body = await res.json();
    expect(body.message).toMatchObject({ fromDid: ALICE, composedBy: JIN });
  });

  it('leaves composedBy null for a direct, undelegated message', async () => {
    const res = await post({ content: { type: 'text', text: 'hi' } });

    expect(res.status).toBe(201);
    expect(h.inserted).toContainEqual(
      expect.objectContaining({ table: 'messages_v2', fromDid: ALICE, composedBy: null }),
    );
    await expect(res.json()).resolves.toMatchObject({ message: { composedBy: null } });
  });

  it('leaves composedBy null for group acting-as — impersonation is not transcription', async () => {
    h.requireAuth.mockResolvedValue({
      identity: { id: ALICE, tier: 'established', handle: 'alice', actingAs: 'did:imajin:group:acme' },
    });

    await post({ content: { type: 'text', text: 'hi' } });

    expect(h.inserted).toContainEqual(
      expect.objectContaining({
        table: 'messages_v2',
        fromDid: 'did:imajin:group:acme',
        composedBy: null,
      }),
    );
  });
});

describe('GET /chat/api/d/:did/messages — composedBy attribution (#1673)', () => {
  function get() {
    return GET({ url: `https://node.test/chat/api/d/${CANONICAL}/messages` } as unknown as NextRequest, {
      params: Promise.resolve({ did: CANONICAL }),
    });
  }

  it('surfaces composedBy alongside fromDid in the list response', async () => {
    h.rows.messages_v2 = [
      { id: 'msg_1', conversationDid: CANONICAL, fromDid: ALICE, composedBy: JIN },
      { id: 'msg_2', conversationDid: CANONICAL, fromDid: ALICE, composedBy: null },
    ];

    const res = await get();

    expect(res.status).toBe(200);
    const body = await res.json();
    // Newest-last ordering reverses the rows the query returned.
    expect(body.messages).toEqual([
      expect.objectContaining({ id: 'msg_2', fromDid: ALICE, composedBy: null }),
      expect.objectContaining({ id: 'msg_1', fromDid: ALICE, composedBy: JIN }),
    ]);
  });
});
