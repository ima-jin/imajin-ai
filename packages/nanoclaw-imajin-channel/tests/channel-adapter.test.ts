import { afterEach, describe, expect, it, vi } from 'vitest';
import { createImajinChatAdapter } from '../src/channel-adapter.js';
import type { NanoClawChannelSetup } from '../src/nanoclaw-types.js';

/** Minimal fake WebSocket the test drives directly via emit(). */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  readyState = FakeWebSocket.OPEN;
  listeners = new Map<string, Array<(event: unknown) => void>>();
  closed: { code?: number; reason?: string } | null = null;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    this.emit('close', { code: code ?? 1000, reason: reason ?? '' });
  }

  emit(type: string, event: unknown = {}): void {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }
}

function stubAuthFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith('/auth/api/login/challenge')) {
      return new Response(JSON.stringify({ challengeId: 'c1', challenge: 'abcd' }), { status: 200 });
    }
    if (url.endsWith('/auth/api/login/verify')) {
      return new Response(null, { status: 200, headers: { 'set-cookie': 'session=live; Path=/' } });
    }
    throw new Error(`unexpected fetch in this test: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('createImajinChatAdapter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    FakeWebSocket.instances = [];
  });

  it('declares a DM-only, non-threaded, dm-only-mentions channel', () => {
    const adapter = createImajinChatAdapter({
      kernelBaseUrl: 'https://kernel.example.com',
      agentDid: 'did:imajin:agent-poc',
      privateKeyHex: '22'.repeat(32),
    });
    expect(adapter.name).toBe('imajin-chat');
    expect(adapter.supportsThreads).toBe(false);
    expect(adapter.defaults?.mentions).toBe('dm-only');
  });

  it('dispatches an inbound chat_message frame to onInbound, addressed as a mention with no thread', async () => {
    stubAuthFetch();
    vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);

    const adapter = createImajinChatAdapter({
      kernelBaseUrl: 'https://kernel.example.com',
      agentDid: 'did:imajin:agent-poc',
      privateKeyHex: '22'.repeat(32),
    });

    const onInbound = vi.fn();
    const setup: NanoClawChannelSetup = { onInbound, onMetadata: vi.fn(), onAction: vi.fn() };
    await adapter.setup(setup);

    const ws = FakeWebSocket.instances[0];
    ws.emit('open');
    ws.emit(
      'message',
      {
        data: JSON.stringify({
          type: 'chat_message',
          conversationDid: 'did:imajin:dm:abc',
          message: { id: 'm1', fromDid: 'did:imajin:owner', content: { type: 'text', text: 'hi' }, createdAt: '2026-01-01T00:00:00Z' },
        }),
      },
    );

    // onInbound is invoked fire-and-forget inside the frame handler; flush microtasks.
    await Promise.resolve();
    await Promise.resolve();

    expect(onInbound).toHaveBeenCalledWith(
      'did:imajin:dm:abc',
      null,
      expect.objectContaining({ id: 'm1', kind: 'chat', isMention: true, isGroup: false }),
    );

    await adapter.teardown();
  });

  it('ignores malformed and non-chat_message frames without throwing', async () => {
    stubAuthFetch();
    vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);

    const adapter = createImajinChatAdapter({
      kernelBaseUrl: 'https://kernel.example.com',
      agentDid: 'did:imajin:agent-poc',
      privateKeyHex: '22'.repeat(32),
    });
    const onInbound = vi.fn();
    await adapter.setup({ onInbound, onMetadata: vi.fn(), onAction: vi.fn() });

    const ws = FakeWebSocket.instances[0];
    expect(() => ws.emit('message', { data: 'not json' })).not.toThrow();
    expect(() => ws.emit('message', { data: JSON.stringify({ type: 'notification', id: 'n1' }) })).not.toThrow();
    expect(onInbound).not.toHaveBeenCalled();

    await adapter.teardown();
  });

  it('resets the session and reconnects on an auth-failure frame', async () => {
    stubAuthFetch();
    vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);

    const adapter = createImajinChatAdapter({
      kernelBaseUrl: 'https://kernel.example.com',
      agentDid: 'did:imajin:agent-poc',
      privateKeyHex: '22'.repeat(32),
    });
    await adapter.setup({ onInbound: vi.fn(), onMetadata: vi.fn(), onAction: vi.fn() });

    const ws = FakeWebSocket.instances[0];
    ws.emit('message', { data: JSON.stringify({ type: 'auth_required' }) });

    expect(ws.closed).toEqual({ code: 4001, reason: 'auth refresh' });

    await adapter.teardown();
  });

  it('deliver() sends the reply as the agent itself (no delegation) and returns the sent id', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/auth/api/login/challenge')) {
        return new Response(JSON.stringify({ challengeId: 'c1', challenge: 'abcd' }), { status: 200 });
      }
      if (url.endsWith('/auth/api/login/verify')) {
        return new Response(null, { status: 200, headers: { 'set-cookie': 'session=live; Path=/' } });
      }
      if (url.includes('/chat/api/d/')) {
        const headers = new Headers(init?.headers);
        expect(headers.has('X-Acting-For')).toBe(false);
        return new Response(JSON.stringify({ message: { id: 'reply-1' } }), { status: 201 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = createImajinChatAdapter({
      kernelBaseUrl: 'https://kernel.example.com',
      agentDid: 'did:imajin:agent-poc',
      privateKeyHex: '22'.repeat(32),
    });

    const messageId = await adapter.deliver('did:imajin:dm:abc', null, { kind: 'text', content: { text: 'reply text' } });
    expect(messageId).toBe('reply-1');
  });

  it('deliver() is a no-op when there is no text to send', async () => {
    const adapter = createImajinChatAdapter({
      kernelBaseUrl: 'https://kernel.example.com',
      agentDid: 'did:imajin:agent-poc',
      privateKeyHex: '22'.repeat(32),
    });
    const result = await adapter.deliver('did:imajin:dm:abc', null, { kind: 'text', content: {} });
    expect(result).toBeUndefined();
  });
});
