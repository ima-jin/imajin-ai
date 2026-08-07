import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpContent, McpToolContext } from '../types';

// ─── Mocks ─────────────────────────────────────────────────────────────────

// In-process chat lib backing the messages tools.
vi.mock('@/src/lib/chat/queries', () => ({
  listConversations: vi.fn(),
  readConversationMessages: vi.fn(),
  sendTextMessageAsDid: vi.fn(),
}));

// Bypass the scope-manifest channel_links gate — gate unit tests live in
// mcp-grant.test.ts / scope-gate.test.ts; here we exercise the tool logic.
vi.mock('../mcp-grant', () => ({ requireMcpGrant: vi.fn().mockResolvedValue(undefined) }));

import { messagesTools } from '../tools/messages';
import { requireMcpGrant } from '../mcp-grant';
import {
  listConversations,
  readConversationMessages,
  sendTextMessageAsDid,
} from '@/src/lib/chat/queries';
import { dmDid } from '@/src/lib/chat/conversation-did';

// ─── Helpers ───────────────────────────────────────────────────────────────

const ctx: McpToolContext = {
  did: 'did:imajin:user',
  appDid: 'did:imajin:app',
  scopes: new Set(['messages:read', 'messages:write']),
};

function tool(name: string) {
  const t = messagesTools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
}

function parseResult(content: McpContent[]) {
  return JSON.parse(content[0].text);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── imajin_list_conversations ───────────────────────────────────────────────

describe('imajin_list_conversations', () => {
  it('requires the messages:read scope', () => {
    expect(tool('imajin_list_conversations').requiredScope).toBe('messages:read');
  });

  it('gates on messages:read and returns a compact conversation list', async () => {
    vi.mocked(listConversations).mockResolvedValueOnce([
      {
        did: 'did:imajin:dm:abc',
        name: null,
        type: 'dm',
        slug: 'abc',
        createdBy: ctx.did,
        createdAt: new Date('2026-07-01T00:00:00Z'),
        lastMessageAt: new Date('2026-07-02T00:00:00Z'),
        lastMessagePreview: 'hi there',
        unread: 2,
        otherParticipant: { did: 'did:imajin:other', handle: 'eric', name: 'Eric' },
      },
    ]);

    const res = await tool('imajin_list_conversations').handler({}, ctx);

    expect(requireMcpGrant).toHaveBeenCalledWith(ctx.did, 'messages:read');
    expect(listConversations).toHaveBeenCalledWith(ctx.did);

    const out = parseResult(res as McpContent[]);
    expect(out.count).toBe(1);
    expect(out.conversations[0].conversation_id).toBe('did:imajin:dm:abc');
    expect(out.conversations[0].other_participant.handle).toBe('eric');
    expect(out.conversations[0].unread).toBe(2);
  });
});

// ─── imajin_read_messages ─────────────────────────────────────────────────────

describe('imajin_read_messages', () => {
  it('requires conversation_id', () => {
    expect(tool('imajin_read_messages').inputSchema.required).toEqual(['conversation_id']);
  });

  it('gates on messages:read, forwards the limit, and maps message text', async () => {
    vi.mocked(readConversationMessages).mockResolvedValueOnce({
      ok: true,
      hasMore: false,
      messages: [
        {
          id: 'msg_1',
          fromDid: 'did:imajin:other',
          contentType: 'text',
          content: { type: 'text', text: 'hello' },
          createdAt: new Date('2026-07-02T00:00:00Z'),
        },
      ] as never,
    });

    const res = await tool('imajin_read_messages').handler(
      { conversation_id: 'did:imajin:dm:abc', limit: 10 },
      ctx,
    );

    expect(requireMcpGrant).toHaveBeenCalledWith(ctx.did, 'messages:read');
    expect(readConversationMessages).toHaveBeenCalledWith(ctx.did, 'did:imajin:dm:abc', 10);

    const out = parseResult(res as McpContent[]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'msg_1', from: 'did:imajin:other', text: 'hello' });
  });

  it('defaults the limit to 50 when omitted', async () => {
    vi.mocked(readConversationMessages).mockResolvedValueOnce({ ok: true, hasMore: false, messages: [] });
    await tool('imajin_read_messages').handler({ conversation_id: 'did:imajin:dm:abc' }, ctx);
    expect(readConversationMessages).toHaveBeenCalledWith(ctx.did, 'did:imajin:dm:abc', 50);
  });

  it('throws when conversation_id is missing', async () => {
    await expect(tool('imajin_read_messages').handler({}, ctx)).rejects.toThrow(/conversation_id/);
    expect(readConversationMessages).not.toHaveBeenCalled();
  });

  it('surfaces an access-denied result as an error', async () => {
    vi.mocked(readConversationMessages).mockResolvedValueOnce({
      ok: false,
      status: 404,
      error: 'Conversation not found or access denied',
    });
    await expect(
      tool('imajin_read_messages').handler({ conversation_id: 'did:imajin:dm:x' }, ctx),
    ).rejects.toThrow(/not found or access denied/);
  });
});

// ─── imajin_send_message ──────────────────────────────────────────────────────

describe('imajin_send_message', () => {
  it('requires the messages:write scope', () => {
    expect(tool('imajin_send_message').requiredScope).toBe('messages:write');
  });

  it('gates on messages:write, sends onBehalfOf the caller, and returns the message id', async () => {
    vi.mocked(sendTextMessageAsDid).mockResolvedValueOnce({
      ok: true,
      message: { id: 'msg_new', createdAt: new Date('2026-07-03T00:00:00Z') } as never,
    });

    const res = await tool('imajin_send_message').handler(
      { conversation_id: 'did:imajin:dm:abc', content: 'yo' },
      ctx,
    );

    expect(requireMcpGrant).toHaveBeenCalledWith(ctx.did, 'messages:write');
    expect(sendTextMessageAsDid).toHaveBeenCalledWith(ctx.did, 'did:imajin:dm:abc', 'yo');

    const out = parseResult(res as McpContent[]);
    expect(out).toMatchObject({ sent: true, conversation_id: 'did:imajin:dm:abc', message_id: 'msg_new' });
  });

  it('throws when content is missing', async () => {
    await expect(
      tool('imajin_send_message').handler({ conversation_id: 'did:imajin:dm:abc' }, ctx),
    ).rejects.toThrow(/content/);
    expect(sendTextMessageAsDid).not.toHaveBeenCalled();
  });

  it('surfaces a send failure (e.g. verify-required) as an error', async () => {
    vi.mocked(sendTextMessageAsDid).mockResolvedValueOnce({
      ok: false,
      status: 403,
      error: 'Please verify your account to send messages',
    });
    await expect(
      tool('imajin_send_message').handler({ conversation_id: 'did:imajin:dm:abc', content: 'yo' }, ctx),
    ).rejects.toThrow(/verify your account/);
  });
});

// ─── imajin_send_dm ───────────────────────────────────────────────────────────

describe('imajin_send_dm', () => {
  const recipient = 'did:imajin:other';

  it('requires the messages:write scope', () => {
    expect(tool('imajin_send_dm').requiredScope).toBe('messages:write');
  });

  it('requires both to and content', () => {
    expect(tool('imajin_send_dm').inputSchema.required).toEqual(['to', 'content']);
  });

  it('gates on messages:write and sends to the canonical dmDid conversation', async () => {
    vi.mocked(sendTextMessageAsDid).mockResolvedValueOnce({
      ok: true,
      message: { id: 'msg_dm', createdAt: new Date('2026-07-04T00:00:00Z') } as never,
    });

    const res = await tool('imajin_send_dm').handler({ to: recipient, content: 'yo' }, ctx);

    const expectedDid = dmDid(ctx.did, recipient);
    expect(requireMcpGrant).toHaveBeenCalledWith(ctx.did, 'messages:write');
    expect(sendTextMessageAsDid).toHaveBeenCalledWith(ctx.did, expectedDid, 'yo');

    const out = parseResult(res as McpContent[]);
    expect(out).toMatchObject({
      sent: true,
      conversation_id: expectedDid,
      message_id: 'msg_dm',
    });
  });

  it('derives the same conversation DID regardless of who sends first', async () => {
    expect(dmDid(ctx.did, recipient)).toBe(dmDid(recipient, ctx.did));
  });

  it('throws when to is missing', async () => {
    await expect(tool('imajin_send_dm').handler({ content: 'yo' }, ctx)).rejects.toThrow(/to/);
    expect(sendTextMessageAsDid).not.toHaveBeenCalled();
  });

  it('throws when content is missing', async () => {
    await expect(tool('imajin_send_dm').handler({ to: recipient }, ctx)).rejects.toThrow(/content/);
    expect(sendTextMessageAsDid).not.toHaveBeenCalled();
  });

  it('surfaces a send failure as an error', async () => {
    vi.mocked(sendTextMessageAsDid).mockResolvedValueOnce({
      ok: false,
      status: 403,
      error: 'Please verify your account to send messages',
    });
    await expect(
      tool('imajin_send_dm').handler({ to: recipient, content: 'yo' }, ctx),
    ).rejects.toThrow(/verify your account/);
  });
});
