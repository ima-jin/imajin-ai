import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────
// The DM guard itself is unit-tested in dm-guard.test.ts. Here it is stubbed so
// we can assert that sendConversationMessage refuses a gated send and writes to
// the DID the guard resolved — never the one the caller passed.

const h = vi.hoisted(() => ({
  resolveDmConversationTarget: vi.fn(),
  checkAccess: vi.fn(),
  inserted: [] as Record<string, unknown>[],
  conversations: [] as { did: string }[],
}));

vi.mock('@imajin/bus', () => ({ publish: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@imajin/db', () => ({ getClient: () => vi.fn() }));
vi.mock('@imajin/auth', () => ({ isVerifiedTier: (tier?: string) => tier !== 'soft' }));

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
      conversationsV2: {
        findFirst: ({ where }: { where: { val: string } }) =>
          Promise.resolve(h.conversations.find((c) => c.did === where.val)),
      },
      messagesV2: { findFirst: () => Promise.resolve({ id: 'msg_1' }) },
    },
    insert: (table: { name: string }) => ({
      values: (row: Record<string, unknown>) => {
        h.inserted.push({ table: table.name, ...row });
        return Object.assign(Promise.resolve(), {
          onConflictDoNothing: () => Promise.resolve(),
        });
      },
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  },
  conversationsV2: { name: 'conversations_v2', did: 'did' },
  messagesV2: { name: 'messages_v2', id: 'id', conversationDid: 'conversationDid', fromDid: 'fromDid' },
  conversationReadsV2: { name: 'conversation_reads_v2' },
  messageReactionsV2: { name: 'message_reactions_v2' },
}));

vi.mock('@/src/lib/kernel/access', () => ({ checkAccess: h.checkAccess }));
vi.mock('@/src/lib/kernel/utils', () => ({ generateId: () => 'msg_1' }));
vi.mock('@/src/lib/kernel/lookup', () => ({ lookupIdentity: vi.fn() }));
vi.mock('@/src/lib/chat/mentions', () => ({ processMentions: vi.fn() }));
vi.mock('../mentions', () => ({ processMentions: vi.fn() }));
vi.mock('../dm-guard', () => ({ resolveDmConversationTarget: h.resolveDmConversationTarget }));

import { sendConversationMessage } from '../queries';

const ALICE = 'did:imajin:alice';
const BOB = 'did:imajin:bob';
const CANONICAL = 'did:imajin:dm:1234567890abcdef';

beforeEach(() => {
  h.inserted.splice(0);
  h.conversations.splice(0);
  h.resolveDmConversationTarget.mockReset();
  h.checkAccess.mockResolvedValue({ allowed: true });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
});

describe('sendConversationMessage — DM guard (#1649, #855)', () => {
  it('refuses the send with the guard status and message', async () => {
    h.resolveDmConversationTarget.mockResolvedValue({
      ok: false,
      status: 403,
      error: 'You must be connected to message this person',
    });

    const result = await sendConversationMessage({
      senderDid: ALICE,
      senderTier: 'established',
      conversationDid: BOB,
      content: { type: 'text', text: 'hi' },
    });

    expect(result).toEqual({
      ok: false,
      status: 403,
      error: 'You must be connected to message this person',
    });
    expect(h.inserted).toHaveLength(0);
    expect(h.checkAccess).not.toHaveBeenCalled();
  });

  it('writes the message to the DID the guard resolved, not the one passed in', async () => {
    h.resolveDmConversationTarget.mockResolvedValue({ ok: true, conversationDid: CANONICAL, exists: false });

    const result = await sendConversationMessage({
      senderDid: ALICE,
      senderTier: 'established',
      conversationDid: BOB,
      recipientDid: BOB,
      content: { type: 'text', text: 'hi' },
    });

    expect(result.ok).toBe(true);
    expect(h.resolveDmConversationTarget).toHaveBeenCalledWith({
      conversationDid: BOB,
      senderDid: ALICE,
      recipientDid: BOB,
    });
    expect(h.checkAccess).toHaveBeenCalledWith(ALICE, CANONICAL);

    const conversationInsert = h.inserted.find((r) => r.table === 'conversations_v2');
    const messageInsert = h.inserted.find((r) => r.table === 'messages_v2');
    expect(conversationInsert).toMatchObject({ did: CANONICAL });
    expect(messageInsert).toMatchObject({ conversationDid: CANONICAL, fromDid: ALICE });
  });
});

describe('sendConversationMessage — composedBy attribution (#1673)', () => {
  const JIN = 'did:imajin:jin';

  async function send(extra: Record<string, unknown> = {}) {
    h.resolveDmConversationTarget.mockResolvedValue({ ok: true, conversationDid: CANONICAL, exists: true });
    h.conversations.push({ did: CANONICAL });
    return sendConversationMessage({
      senderDid: ALICE,
      senderTier: 'established',
      conversationDid: CANONICAL,
      content: { type: 'text', text: 'hi' },
      ...extra,
    });
  }

  it('persists the composing agent without touching fromDid', async () => {
    const result = await send({ composedBy: JIN });

    expect(result.ok).toBe(true);
    expect(h.inserted.find((r) => r.table === 'messages_v2')).toMatchObject({
      fromDid: ALICE,
      composedBy: JIN,
    });
  });

  it('writes null when the caller passes no composer', async () => {
    await send();

    expect(h.inserted.find((r) => r.table === 'messages_v2')).toMatchObject({
      fromDid: ALICE,
      composedBy: null,
    });
  });

  it('collapses a self-composed message to null rather than echoing the sender', async () => {
    await send({ composedBy: ALICE });

    expect(h.inserted.find((r) => r.table === 'messages_v2')).toMatchObject({ composedBy: null });
  });
});
