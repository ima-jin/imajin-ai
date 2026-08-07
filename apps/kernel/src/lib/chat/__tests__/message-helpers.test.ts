/**
 * Tests for ensureConversation's canonical-DID rewrite (#1649).
 *
 * The bug this guards against: a raw person DID used as a conversation key
 * opened a SECOND thread beside the canonical pair thread. ensureConversation
 * now rewrites the key first and returns what it actually ensured, so every
 * assertion here checks the canonical DID reached the writes — returning the
 * input unchanged would reintroduce the duplicate.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  canonicalDmConversationDid: vi.fn(),
  conversations: [] as { did: string }[],
  inserted: [] as Record<string, unknown>[],
}));

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ col, val }),
  and: (...preds: unknown[]) => ({ preds }),
  ne: (col: unknown, val: unknown) => ({ col, val }),
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
          return Promise.resolve();
        },
      }),
    }),
  },
  conversationsV2: { name: 'conversations_v2', did: 'did' },
  conversationMembers: { name: 'conversation_members' },
  messagesV2: { name: 'messages_v2', conversationDid: 'conversationDid', fromDid: 'fromDid' },
}));

vi.mock('../dm-guard', () => ({
  canonicalDmConversationDid: h.canonicalDmConversationDid,
}));

vi.mock('../unfurl', () => ({ unfurlLinks: vi.fn().mockResolvedValue([]) }));

import { ensureConversation } from '../message-helpers';

const ALICE = 'did:imajin:alice';
const BOB = 'did:imajin:bob';
const CANONICAL = 'did:imajin:dm:1234567890abcdef';

beforeEach(() => {
  h.conversations.splice(0);
  h.inserted.splice(0);
  h.canonicalDmConversationDid.mockReset();
});

describe('ensureConversation — canonical DM rewrite (#1649)', () => {
  it('rewrites a raw person DID to the canonical pair DID before writing', async () => {
    h.canonicalDmConversationDid.mockResolvedValue(CANONICAL);

    const result = await ensureConversation(BOB, ALICE, null, BOB);

    expect(h.canonicalDmConversationDid).toHaveBeenCalledWith(BOB, ALICE, BOB);
    // Caller must be handed the DID actually ensured, not the one passed in.
    expect(result).toBe(CANONICAL);

    const conversation = h.inserted.find((r) => r.table === 'conversations_v2');
    const member = h.inserted.find((r) => r.table === 'conversation_members');
    expect(conversation).toMatchObject({ did: CANONICAL, createdBy: ALICE });
    expect(member).toMatchObject({ conversationDid: CANONICAL, memberDid: ALICE });
  });

  it('does not recreate a conversation that already exists', async () => {
    h.canonicalDmConversationDid.mockResolvedValue(CANONICAL);
    h.conversations.push({ did: CANONICAL });

    const result = await ensureConversation(BOB, ALICE, null, BOB);

    expect(result).toBe(CANONICAL);
    expect(h.inserted.some((r) => r.table === 'conversations_v2')).toBe(false);
    // Membership is still asserted every send — it is idempotent by design.
    expect(h.inserted.some((r) => r.table === 'conversation_members')).toBe(true);
  });

  it('honours an explicit conversation name instead of deriving one', async () => {
    h.canonicalDmConversationDid.mockResolvedValue('did:imajin:group:abc123');

    await ensureConversation('did:imajin:group:abc123', ALICE, 'Studio');

    expect(h.inserted.find((r) => r.table === 'conversations_v2')).toMatchObject({
      name: 'Studio',
    });
  });

  it('defaults recipientDid to null when the caller omits it', async () => {
    h.canonicalDmConversationDid.mockResolvedValue(CANONICAL);

    await ensureConversation(BOB, ALICE);

    expect(h.canonicalDmConversationDid).toHaveBeenCalledWith(BOB, ALICE, null);
  });
});
