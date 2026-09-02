import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

const { mockRecordInferenceUsage } = vi.hoisted(() => ({ mockRecordInferenceUsage: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../usage-ledger', () => ({ recordInferenceUsage: mockRecordInferenceUsage }));

import { forwardOpenAiCompatible } from '../openai-compatible-adapter';
import { UpstreamTimeoutError, UpstreamUnavailableError } from '../errors';
import type { ResolvedBrain } from '../../brain';

const XAI_BRAIN: ResolvedBrain = {
  connector: 'xai',
  credentialDid: 'did:imajin:supplier',
  provider: 'openai',
  modelId: 'grok-4',
  apiKey: 'xai-secret-key',
  baseURL: 'https://api.x.ai/v1',
};

describe('forwardOpenAiCompatible', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('forwards a non-streaming request to {baseURL}/chat/completions with the sealed key and resolved model', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'chatcmpl-1', choices: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const res = await forwardOpenAiCompatible(
      XAI_BRAIN,
      { messages: [{ role: 'user', content: 'hi' }] },
      {},
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.x.ai/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer xai-secret-key');
    expect(JSON.parse(init.body)).toEqual({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'grok-4',
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(await res.json()).toEqual({ id: 'chatcmpl-1', choices: [] });
  });

  it('never leaks the sealed key into the client-facing response', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );

    const res = await forwardOpenAiCompatible(XAI_BRAIN, { messages: [] }, {});

    expect(JSON.stringify(Array.from(res.headers.entries()))).not.toContain('xai-secret-key');
    expect(await res.text()).not.toContain('xai-secret-key');
  });

  it('sets SSE-friendly headers and streams the body through for stream: true', async () => {
    const upstreamStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[]}\n\n'));
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    fetchMock.mockResolvedValueOnce(
      new Response(upstreamStream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );

    const res = await forwardOpenAiCompatible(XAI_BRAIN, { messages: [], stream: true }, {});

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Accept).toBe('text/event-stream');
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');
    expect(res.headers.get('Cache-Control')).toBe('no-cache');
    const text = await res.text();
    expect(text).toContain('data: [DONE]');
  });

  it('forwards tools and tool_choice verbatim (no translation for OpenAI-compatible providers)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const tools = [{ type: 'function', function: { name: 'get_weather', parameters: {} } }];

    await forwardOpenAiCompatible(
      XAI_BRAIN,
      { messages: [], tools, tool_choice: 'auto' },
      {},
    );

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toMatchObject({ tools, tool_choice: 'auto' });
  });

  it('forwards a non-2xx upstream status and body untouched', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'model_deprecated' } }), {
        status: 422,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const res = await forwardOpenAiCompatible(XAI_BRAIN, { messages: [] }, {});

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: { message: 'model_deprecated' } });
  });

  it('throws UpstreamTimeoutError when fetch aborts on timeout', async () => {
    fetchMock.mockImplementationOnce(() => {
      const err = new Error('The operation was aborted');
      err.name = 'TimeoutError';
      return Promise.reject(err);
    });

    await expect(forwardOpenAiCompatible(XAI_BRAIN, { messages: [] }, {})).rejects.toBeInstanceOf(UpstreamTimeoutError);
  });

  it('throws UpstreamUnavailableError on a network failure', async () => {
    fetchMock.mockImplementationOnce(() => Promise.reject(new TypeError('fetch failed')));

    await expect(forwardOpenAiCompatible(XAI_BRAIN, { messages: [] }, {})).rejects.toBeInstanceOf(UpstreamUnavailableError);
  });

  it('throws when the connector has no baseURL configured', async () => {
    const brainWithoutBaseUrl: ResolvedBrain = { ...XAI_BRAIN, baseURL: undefined };
    await expect(forwardOpenAiCompatible(brainWithoutBaseUrl, { messages: [] }, {})).rejects.toThrow(
      /completions_no_base_url/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
