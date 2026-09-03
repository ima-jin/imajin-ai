import { describe, expect, it } from 'vitest';
import { toDispatchTarget } from '../src/dispatch.js';
import type { ChatMessageFrame } from '../src/imajin-client.js';

describe('toDispatchTarget', () => {
  it('maps a chat_message frame to NanoClaw inbound-dispatch shape', () => {
    const frame: ChatMessageFrame = {
      type: 'chat_message',
      conversationDid: 'did:imajin:dm:abc123',
      message: {
        id: 'msg-42',
        fromDid: 'did:imajin:owner-ryan',
        content: { type: 'text', text: 'hey there' },
        createdAt: '2026-09-02T12:00:00.000Z',
      },
    };

    const target = toDispatchTarget(frame);

    expect(target.platformId).toBe('did:imajin:dm:abc123');
    expect(target.threadId).toBeNull();
    expect(target.message).toEqual({
      id: 'msg-42',
      kind: 'chat',
      content: { type: 'text', text: 'hey there' },
      timestamp: '2026-09-02T12:00:00.000Z',
      isMention: true,
      isGroup: false,
    });
  });
});
