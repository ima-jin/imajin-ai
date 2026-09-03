import { afterEach, describe, expect, it, vi } from 'vitest';
import { isAuthFailureFrame, isChatMessageFrame, parseFrame, sendChatMessage } from '../src/imajin-client.js';
import { mockKernelAuthFetch } from './support/mock-kernel-auth.js';

describe('parseFrame', () => {
  it('returns null for empty and pong frames', () => {
    expect(parseFrame('')).toBeNull();
    expect(parseFrame('pong')).toBeNull();
  });

  it('returns null for malformed JSON rather than throwing', () => {
    expect(parseFrame('{not json')).toBeNull();
  });

  it('returns null for a JSON value with no string type field', () => {
    expect(parseFrame('{"foo":"bar"}')).toBeNull();
    expect(parseFrame('"just a string"')).toBeNull();
  });

  it('parses a well-formed frame', () => {
    expect(parseFrame('{"type":"chat_message","conversationDid":"did:x"}')).toEqual({
      type: 'chat_message',
      conversationDid: 'did:x',
    });
  });
});

describe('isChatMessageFrame', () => {
  it('accepts a well-formed chat_message frame', () => {
    const frame = {
      type: 'chat_message' as const,
      conversationDid: 'did:imajin:dm:abc',
      message: { id: 'msg-1', fromDid: 'did:imajin:sender', content: { type: 'text', text: 'hi' }, createdAt: '2026-01-01T00:00:00Z' },
    };
    expect(isChatMessageFrame(frame)).toBe(true);
  });

  it('rejects frames missing required fields', () => {
    expect(isChatMessageFrame({ type: 'chat_message' })).toBe(false);
    expect(isChatMessageFrame({ type: 'chat_message', conversationDid: 'did:x' })).toBe(false);
    expect(isChatMessageFrame({ type: 'notification' })).toBe(false);
  });
});

describe('isAuthFailureFrame', () => {
  it('flags auth_required frames', () => {
    expect(isAuthFailureFrame({ type: 'auth_required' })).toBe(true);
  });

  it('flags error frames whose message mentions auth', () => {
    expect(isAuthFailureFrame({ type: 'error', message: 'Auth session expired' })).toBe(true);
  });

  it('does not flag unrelated error frames', () => {
    expect(isAuthFailureFrame({ type: 'error', message: 'rate limited' })).toBe(false);
    expect(isAuthFailureFrame({ type: 'ping' })).toBe(false);
  });
});

describe('sendChatMessage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('authenticates then posts, and never sends an X-Acting-For header', async () => {
    const fetchMock = mockKernelAuthFetch((url, init) => {
      if (url.includes('/chat/api/d/')) {
        const headers = new Headers(init?.headers);
        expect(headers.has('X-Acting-For')).toBe(false);
        expect(headers.get('Cookie')).toBe('session=abc123');
        const body = JSON.parse(String(init?.body)) as { content: { text: string } };
        expect(body.content.text).toBe('hello from the agent');
        return new Response(JSON.stringify({ message: { id: 'sent-msg-1' } }), { status: 201 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }, 'session=abc123; Path=/; HttpOnly');
    vi.stubGlobal('fetch', fetchMock);

    const sent = await sendChatMessage(
      { kernelBaseUrl: 'https://kernel.example.com', did: 'did:imajin:agent-poc', privateKeyHex: '00'.repeat(32) },
      'did:imajin:dm:abc',
      'hello from the agent',
    );

    expect(sent.id).toBe('sent-msg-1');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('surfaces the kernel error message on a failed send', async () => {
    vi.stubGlobal(
      'fetch',
      mockKernelAuthFetch(async () => new Response(JSON.stringify({ error: 'conversation not found' }), { status: 404 })),
    );

    await expect(
      sendChatMessage(
        { kernelBaseUrl: 'https://kernel.example.com', did: 'did:imajin:agent-poc', privateKeyHex: '00'.repeat(32) },
        'did:imajin:dm:missing',
        'hi',
      ),
    ).rejects.toThrow(/conversation not found/);
  });
});
