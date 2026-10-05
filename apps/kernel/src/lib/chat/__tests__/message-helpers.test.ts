/**
 * Tests for ensureConversation's canonical-DID rewrite (#1649).
 *
 * The bug this guards against: a raw person DID used as a conversation key
 * opened a SECOND thread beside the canonical pair thread. ensureConversation
 * now rewrites the key first and returns what it actually ensured, so every
 * assertion here checks the canonical DID reached the writes — returning the
 * input unchanged would reintroduce the duplicate.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  canonicalDmConversationDid: vi.fn(),
  conversations: [] as { did: string }[],
  inserted: [] as Record<string, unknown>[],
  updated: [] as Record<string, unknown>[],
  unfurlLinks: vi.fn(),
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
    update: (table: { name: string }) => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          h.updated.push({ table: table.name, ...values });
          return Promise.resolve();
        },
      }),
    }),
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

vi.mock('../unfurl', () => ({ unfurlLinks: h.unfurlLinks }));

import { ensureConversation, triggerLinkUnfurl } from '../message-helpers';

const ALICE = 'did:imajin:alice';
const BOB = 'did:imajin:bob';
const CANONICAL = 'did:imajin:dm:1234567890abcdef';

beforeEach(() => {
  h.conversations.splice(0);
  h.inserted.splice(0);
  h.updated.splice(0);
  h.canonicalDmConversationDid.mockReset();
  h.unfurlLinks.mockReset().mockResolvedValue([]);
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

describe('triggerLinkUnfurl — fire-and-forget link previews', () => {
  const PREVIEWS = [{ url: 'https://example.com', title: 'Example' }];
  const MESSAGE = { id: 'msg_1', content: 'see https://example.com' };
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('persists the previews and broadcasts a message_updated over the local ws bridge', async () => {
    h.unfurlLinks.mockResolvedValue(PREVIEWS);
    vi.stubEnv('PORT', '4321');

    triggerLinkUnfurl(MESSAGE, MESSAGE.content, 'text', CANONICAL, 'msg_1');

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(h.unfurlLinks).toHaveBeenCalledWith(MESSAGE.content);
    expect(h.updated).toEqual([{ table: 'messages_v2', linkPreviews: PREVIEWS }]);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:4321/__ws_broadcast');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      conversationId: CANONICAL,
      type: 'message_updated',
      message: { ...MESSAGE, linkPreviews: PREVIEWS },
    });
  });

  it('defaults the ws bridge port to 3007 when PORT is unset', async () => {
    h.unfurlLinks.mockResolvedValue(PREVIEWS);
    vi.stubEnv('PORT', '');

    triggerLinkUnfurl(MESSAGE, MESSAGE.content, 'text', CANONICAL, 'msg_1');

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:3007/__ws_broadcast');
  });

  it('does nothing when there are no previews to store', async () => {
    h.unfurlLinks.mockResolvedValue([]);

    triggerLinkUnfurl(MESSAGE, MESSAGE.content, 'text', CANONICAL, 'msg_1');

    await vi.waitFor(() => expect(h.unfurlLinks).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.updated).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing message', null, 'hi', 'text'],
    ['a non-text content type', MESSAGE, 'hi', 'image'],
    ['non-string content', MESSAGE, { not: 'text' }, 'text'],
  ])('skips unfurling for %s', async (_label, message, content, contentType) => {
    triggerLinkUnfurl(message, content, contentType, CANONICAL, 'msg_1');

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.unfurlLinks).not.toHaveBeenCalled();
  });

  it('never throws or rejects when unfurling or the broadcast fails', async () => {
    h.unfurlLinks.mockRejectedValueOnce(new Error('network down'));
    expect(() => triggerLinkUnfurl(MESSAGE, MESSAGE.content, 'text', CANONICAL, 'msg_1')).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));

    h.unfurlLinks.mockResolvedValue(PREVIEWS);
    fetchMock.mockRejectedValue(new Error('ws bridge down'));
    triggerLinkUnfurl(MESSAGE, MESSAGE.content, 'text', CANONICAL, 'msg_1');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
