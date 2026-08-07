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
  // Built as flat steps rather than a nested literal: the drizzle select chain
  // is four calls deep, which trips sonarjs/no-nested-functions when inlined.
  const limit = () => Promise.resolve([{ subtype: 'human' }]);
  const where = () => ({ limit });
  const from = () => ({ where });

  return {
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

vi.mock('@imajin/auth', () => ({
  requireAuth: h.requireAuth,
  isVerifiedTier: (tier?: string) => tier !== 'soft',
  canonicalize: (v: unknown) => JSON.stringify(v),
  crypto: { signSync: () => 'sig' },
  resolveActingDid: (identity: { id: string }) => identity.id,
}));

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ col, val }),
  and: (...preds: unknown[]) => ({ preds }),
  desc: (col: unknown) => col,
  lt: (col: unknown, val: unknown) => ({ col, val }),
  isNull: (col: unknown) => ({ col }),
  inArray: (col: unknown, vals: unknown) => ({ col, vals }),
}));

vi.mock('@/src/db', () => ({
  db: {
    query: {
      messagesV2: { findFirst: () => Promise.resolve({ id: 'msg_1', content: { text: 'hi' } }) },
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

import { POST } from '../route';

const ALICE = 'did:imajin:alice';
const BOB = 'did:imajin:bob';
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
