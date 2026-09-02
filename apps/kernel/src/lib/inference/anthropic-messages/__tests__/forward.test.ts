import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

const { mockRecordInferenceUsage } = vi.hoisted(() => ({ mockRecordInferenceUsage: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../usage-ledger', () => ({ recordInferenceUsage: mockRecordInferenceUsage }));

import {
  applySealedModel,
  forwardAnthropicCountTokens,
  forwardAnthropicMessages,
  forwardAnthropicModelsList,
} from '../forward';
import { UpstreamTimeoutError, UpstreamUnavailableError } from '../../completions/errors';
import type { ResolvedBrain } from '../../brain';

const ANTHROPIC_BRAIN: ResolvedBrain = {
  connector: 'anthropic',
  credentialDid: 'did:imajin:supplier',
  provider: 'anthropic',
  modelId: 'claude-opus-4-6',
  apiKey: 'sk-ant-sealed-secret',
};

describe('applySealedModel', () => {
  it('overrides model with the sealed modelId and preserves every other field', () => {
    const result = applySealedModel(
      JSON.stringify({ model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 }),
      'claude-opus-4-6',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(JSON.parse(result.value.value)).toEqual({
      model: 'claude-opus-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
    });
  });

  it('detects stream: true after the override', () => {
    const result = applySealedModel(JSON.stringify({ messages: [], stream: true }), 'claude-opus-4-6');
    expect(result.ok && result.value.stream).toBe(true);
  });

  it('detects a non-streaming request', () => {
    const result = applySealedModel(JSON.stringify({ messages: [] }), 'claude-opus-4-6');
    expect(result.ok && result.value.stream).toBe(false);
  });

  it('rejects invalid JSON', () => {
    const result = applySealedModel('not json', 'claude-opus-4-6');
    expect(result).toEqual({ ok: false, error: 'Invalid JSON body' });
  });

  it('rejects a non-object JSON body', () => {
    const result = applySealedModel(JSON.stringify(['a', 'b']), 'claude-opus-4-6');
    expect(result.ok).toBe(false);
  });
});

describe('forwardAnthropicMessages', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('forwards a non-streaming request to api.anthropic.com/v1/messages with x-api-key auth', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'msg_1', usage: { input_tokens: 10, output_tokens: 5 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const prepared = applySealedModel(JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }), 'claude-opus-4-6');
    if (!prepared.ok) throw new Error('expected ok');

    const res = await forwardAnthropicMessages(ANTHROPIC_BRAIN, prepared.value, {}, {});

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.method).toBe('POST');
    expect(init.headers['x-api-key']).toBe('sk-ant-sealed-secret');
    expect(init.headers.Authorization).toBeUndefined();
    expect(init.headers['anthropic-version']).toBe('2023-06-01');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'msg_1', usage: { input_tokens: 10, output_tokens: 5 } });
  });

  it('forwards the caller-supplied anthropic-version and anthropic-beta headers unchanged', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const prepared = applySealedModel(JSON.stringify({ messages: [] }), 'claude-opus-4-6');
    if (!prepared.ok) throw new Error('expected ok');

    await forwardAnthropicMessages(ANTHROPIC_BRAIN, prepared.value, {}, {
      anthropicVersion: '2024-06-01',
      anthropicBeta: 'context-management-2025-06-27',
    });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers['anthropic-version']).toBe('2024-06-01');
    expect(init.headers['anthropic-beta']).toBe('context-management-2025-06-27');
  });

  it('never leaks the sealed key into the client-facing response', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const prepared = applySealedModel(JSON.stringify({ messages: [] }), 'claude-opus-4-6');
    if (!prepared.ok) throw new Error('expected ok');

    const res = await forwardAnthropicMessages(ANTHROPIC_BRAIN, prepared.value, {}, {});

    expect(JSON.stringify(Array.from(res.headers.entries()))).not.toContain('sk-ant-sealed-secret');
    expect(await res.text()).not.toContain('sk-ant-sealed-secret');
  });

  it('forwards a non-2xx upstream status and body untouched', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad model' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const prepared = applySealedModel(JSON.stringify({ messages: [] }), 'claude-opus-4-6');
    if (!prepared.ok) throw new Error('expected ok');

    const res = await forwardAnthropicMessages(ANTHROPIC_BRAIN, prepared.value, {}, {});

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ type: 'error', error: { type: 'invalid_request_error', message: 'bad model' } });
  });

  it('writes one usage.incurred row for a non-streaming call, with cache fields in metadata', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'msg_1',
          usage: { input_tokens: 100, output_tokens: 42, cache_creation_input_tokens: 8, cache_read_input_tokens: 20 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const prepared = applySealedModel(JSON.stringify({ messages: [] }), 'claude-opus-4-6');
    if (!prepared.ok) throw new Error('expected ok');

    await forwardAnthropicMessages(ANTHROPIC_BRAIN, prepared.value, { sessionId: 'sess_1', turnId: 'turn_1' }, {});

    expect(mockRecordInferenceUsage).toHaveBeenCalledTimes(1);
    expect(mockRecordInferenceUsage).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      turnId: 'turn_1',
      principalDid: 'did:imajin:supplier',
      agentDid: undefined,
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      tokensIn: 100,
      tokensOut: 42,
      metadata: { format: 'anthropic-messages', cacheCreationInputTokens: 8, cacheReadInputTokens: 20 },
    });
  });

  it('writes a degraded usage row (null tokens) when the response is not JSON', async () => {
    fetchMock.mockResolvedValueOnce(new Response('not json', { status: 200 }));
    const prepared = applySealedModel(JSON.stringify({ messages: [] }), 'claude-opus-4-6');
    if (!prepared.ok) throw new Error('expected ok');

    await forwardAnthropicMessages(ANTHROPIC_BRAIN, prepared.value, {}, {});

    expect(mockRecordInferenceUsage).toHaveBeenCalledWith(
      expect.objectContaining({ tokensIn: undefined, tokensOut: undefined, metadata: { format: 'anthropic-messages' } }),
    );
  });

  describe('streaming', () => {
    function sseStream(lines: string[]): ReadableStream<Uint8Array> {
      return new ReadableStream<Uint8Array>({
        start(controller) {
          for (const line of lines) controller.enqueue(new TextEncoder().encode(line));
          controller.close();
        },
      });
    }

    it('sets SSE-friendly headers and streams the body through unchanged', async () => {
      const body = sseStream([
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta"}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":7}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]);
      fetchMock.mockResolvedValueOnce(new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
      const prepared = applySealedModel(JSON.stringify({ messages: [], stream: true }), 'claude-opus-4-6');
      if (!prepared.ok) throw new Error('expected ok');

      const res = await forwardAnthropicMessages(ANTHROPIC_BRAIN, prepared.value, {}, {});

      expect(res.headers.get('Content-Type')).toBe('text/event-stream');
      expect(res.headers.get('Cache-Control')).toBe('no-cache');
      const text = await res.text();
      expect(text).toContain('message_start');
      expect(text).toContain('message_stop');
    });

    it('parses input_tokens/cache fields from message_start and output_tokens from message_delta into one usage row', async () => {
      const body = sseStream([
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":25,"cache_creation_input_tokens":3,"cache_read_input_tokens":9}}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":15}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]);
      fetchMock.mockResolvedValueOnce(new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
      const prepared = applySealedModel(JSON.stringify({ messages: [], stream: true }), 'claude-opus-4-6');
      if (!prepared.ok) throw new Error('expected ok');

      const res = await forwardAnthropicMessages(ANTHROPIC_BRAIN, prepared.value, { sessionId: 's1' }, {});
      await res.text();
      // The metering tap runs on a teed copy, asynchronously — flush microtasks.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(mockRecordInferenceUsage).toHaveBeenCalledWith({
        sessionId: 's1',
        turnId: undefined,
        principalDid: 'did:imajin:supplier',
        agentDid: undefined,
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        tokensIn: 25,
        tokensOut: 15,
        metadata: { format: 'anthropic-messages', cacheCreationInputTokens: 3, cacheReadInputTokens: 9 },
      });
    });
  });

  it('throws UpstreamTimeoutError when fetch aborts on timeout', async () => {
    fetchMock.mockImplementationOnce(() => {
      const err = new Error('The operation was aborted');
      err.name = 'TimeoutError';
      return Promise.reject(err);
    });
    const prepared = applySealedModel(JSON.stringify({ messages: [] }), 'claude-opus-4-6');
    if (!prepared.ok) throw new Error('expected ok');

    await expect(forwardAnthropicMessages(ANTHROPIC_BRAIN, prepared.value, {}, {})).rejects.toBeInstanceOf(UpstreamTimeoutError);
  });

  it('throws UpstreamUnavailableError on a network failure', async () => {
    fetchMock.mockImplementationOnce(() => Promise.reject(new TypeError('fetch failed')));
    const prepared = applySealedModel(JSON.stringify({ messages: [] }), 'claude-opus-4-6');
    if (!prepared.ok) throw new Error('expected ok');

    await expect(forwardAnthropicMessages(ANTHROPIC_BRAIN, prepared.value, {}, {})).rejects.toBeInstanceOf(UpstreamUnavailableError);
  });
});

describe('forwardAnthropicCountTokens', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('forwards to /v1/messages/count_tokens with x-api-key auth and never meters usage', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ input_tokens: 14 }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );

    const res = await forwardAnthropicCountTokens(ANTHROPIC_BRAIN, JSON.stringify({ model: 'claude-opus-4-6', messages: [] }), {});

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages/count_tokens');
    expect(init.headers['x-api-key']).toBe('sk-ant-sealed-secret');
    expect(await res.json()).toEqual({ input_tokens: 14 });
    expect(mockRecordInferenceUsage).not.toHaveBeenCalled();
  });
});

describe('forwardAnthropicModelsList', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('forwards to /v1/models with the query string appended and never meters usage', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } }));

    await forwardAnthropicModelsList(ANTHROPIC_BRAIN, '?after_id=model_1');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/models?after_id=model_1');
    expect(init.method).toBe('GET');
    expect(init.headers['x-api-key']).toBe('sk-ant-sealed-secret');
    expect(mockRecordInferenceUsage).not.toHaveBeenCalled();
  });
});
