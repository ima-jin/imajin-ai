import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

const { mockRecordInferenceUsage } = vi.hoisted(() => ({ mockRecordInferenceUsage: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../usage-ledger', () => ({ recordInferenceUsage: mockRecordInferenceUsage }));

const { mockEgressSafeFetch } = vi.hoisted(() => ({ mockEgressSafeFetch: vi.fn() }));
vi.mock('@/src/lib/kernel/egress-fetch', () => ({ egressSafeFetch: mockEgressSafeFetch }));

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

const LOCAL_BRAIN: ResolvedBrain = {
  connector: 'local',
  credentialDid: 'did:imajin:owner',
  provider: 'openai',
  modelId: 'llama3',
  apiKey: '',
  baseURL: 'http://ollama.lan:11434',
  pinnedIp: '192.168.1.50',
};

const OPENROUTER_BRAIN: ResolvedBrain = {
  connector: 'openrouter',
  credentialDid: 'did:imajin:supplier',
  provider: 'openai',
  modelId: 'typesafe/jev-1.13',
  apiKey: 'sk-or-secret-key',
  baseURL: 'https://openrouter.ai/api/v1',
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

  it('strips a trailing slash (or several) from baseURL before appending /chat/completions (#2074 S8786)', async () => {
    fetchMock.mockImplementation(async () => new Response('{}', { status: 200 }));

    await forwardOpenAiCompatible({ ...XAI_BRAIN, baseURL: 'https://api.x.ai/v1/' }, { messages: [] }, {});
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.x.ai/v1/chat/completions');

    fetchMock.mockClear();
    await forwardOpenAiCompatible({ ...XAI_BRAIN, baseURL: 'https://api.x.ai/v1///' }, { messages: [] }, {});
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.x.ai/v1/chat/completions');
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

  it('#2202: marks the usage.incurred row status=error on a non-streaming upstream 4xx, instead of a bare null-cost "success" row', async () => {
    mockRecordInferenceUsage.mockClear();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'max_tokens unsupported' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await forwardOpenAiCompatible(XAI_BRAIN, { messages: [] }, {});

    expect(mockRecordInferenceUsage).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'xai', model: 'grok-4', status: 'error' }),
    );
  });

  it('#2202: marks the usage.incurred row status=error on a streaming upstream 5xx', async () => {
    mockRecordInferenceUsage.mockClear();
    const upstreamStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"error":"upstream_unavailable"}\n\n'));
        controller.close();
      },
    });
    fetchMock.mockResolvedValueOnce(
      new Response(upstreamStream, { status: 503, headers: { 'content-type': 'text/event-stream' } }),
    );

    const res = await forwardOpenAiCompatible(XAI_BRAIN, { messages: [], stream: true }, {});
    await res.text();

    expect(mockRecordInferenceUsage).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'xai', model: 'grok-4', status: 'error' }),
    );
  });

  it('#2202: omits status entirely on a successful (2xx) call, unchanged from before this field existed', async () => {
    mockRecordInferenceUsage.mockClear();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'chatcmpl-1', choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await forwardOpenAiCompatible(XAI_BRAIN, { messages: [] }, {});

    const call = mockRecordInferenceUsage.mock.calls[0][0];
    expect(call.status).toBeUndefined();
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

  describe('the local connector (#1957)', () => {
    beforeEach(() => {
      mockEgressSafeFetch.mockReset();
    });

    it('routes through egressSafeFetch with the pinned IP, never the bare global fetch', async () => {
      mockEgressSafeFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'chatcmpl-1', choices: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

      const res = await forwardOpenAiCompatible(LOCAL_BRAIN, { messages: [{ role: 'user', content: 'hi' }] }, {});

      expect(fetchMock).not.toHaveBeenCalled();
      expect(mockEgressSafeFetch).toHaveBeenCalledTimes(1);
      const [url, init, opts] = mockEgressSafeFetch.mock.calls[0];
      expect(url).toBe('http://ollama.lan:11434/chat/completions');
      expect(init.headers.Authorization).toBeUndefined();
      expect(opts).toEqual({ connector: 'local', timeoutMs: expect.any(Number), pinnedIp: '192.168.1.50' });
      expect(res.status).toBe(200);
    });

    it('sends the bearer token when one is sealed, and omits it entirely when it is not', async () => {
      mockEgressSafeFetch.mockImplementation(async () => new Response('{}', { status: 200 }));

      await forwardOpenAiCompatible({ ...LOCAL_BRAIN, apiKey: 'sealed-token' }, { messages: [] }, {});
      expect(mockEgressSafeFetch.mock.calls[0][1].headers.Authorization).toBe('Bearer sealed-token');

      mockEgressSafeFetch.mockClear();
      await forwardOpenAiCompatible(LOCAL_BRAIN, { messages: [] }, {});
      expect(mockEgressSafeFetch.mock.calls[0][1].headers).not.toHaveProperty('Authorization');
    });

    it('streams the response through unchanged and still meters usage (#1923)', async () => {
      const upstreamStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[]}\n\n'));
          controller.enqueue(new TextEncoder().encode('data: {"usage":{"prompt_tokens":5,"completion_tokens":7}}\n\n'));
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      mockEgressSafeFetch.mockResolvedValueOnce(
        new Response(upstreamStream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      );

      const res = await forwardOpenAiCompatible(LOCAL_BRAIN, { messages: [], stream: true }, {});
      const text = await res.text();

      expect(text).toContain('data: [DONE]');
      expect(mockRecordInferenceUsage).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'local', model: 'llama3', tokensIn: 5, tokensOut: 7 }),
      );
    });

    it('propagates UpstreamTimeoutError/UpstreamUnavailableError from egressSafeFetch unchanged', async () => {
      mockEgressSafeFetch.mockRejectedValueOnce(new UpstreamTimeoutError('local'));
      await expect(forwardOpenAiCompatible(LOCAL_BRAIN, { messages: [] }, {})).rejects.toBeInstanceOf(UpstreamTimeoutError);

      mockEgressSafeFetch.mockRejectedValueOnce(new UpstreamUnavailableError('local', 'ECONNREFUSED'));
      await expect(forwardOpenAiCompatible(LOCAL_BRAIN, { messages: [] }, {})).rejects.toBeInstanceOf(UpstreamUnavailableError);
    });
  });

  describe('the OpenRouter connector (#2188)', () => {
    it('sends the recommended attribution headers, which every other connector omits', async () => {
      fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));

      await forwardOpenAiCompatible(OPENROUTER_BRAIN, { messages: [] }, {});

      const [, init] = fetchMock.mock.calls[0];
      expect(init.headers['HTTP-Referer']).toBe('https://imajin.ai');
      expect(init.headers['X-Title']).toBe('Imajin');

      fetchMock.mockClear();
      fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
      await forwardOpenAiCompatible(XAI_BRAIN, { messages: [] }, {});
      const [, xaiInit] = fetchMock.mock.calls[0];
      expect(xaiInit.headers['HTTP-Referer']).toBeUndefined();
      expect(xaiInit.headers['X-Title']).toBeUndefined();
    });

    it('asks for usage.cost via usage: { include: true } on both non-streaming and streaming requests', async () => {
      fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
      await forwardOpenAiCompatible(OPENROUTER_BRAIN, { messages: [] }, {});
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ usage: { include: true } });

      fetchMock.mockClear();
      fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
      await forwardOpenAiCompatible(OPENROUTER_BRAIN, { messages: [], stream: true }, {});
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
        usage: { include: true },
        stream_options: { include_usage: true },
      });

      fetchMock.mockClear();
      fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
      await forwardOpenAiCompatible(XAI_BRAIN, { messages: [] }, {});
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty('usage');
    });

    /**
     * MUST-HAVE acceptance (#2188): the target model `typesafe/jev-1.13` has
     * no text output modality — its schema is delivered via `tools`/
     * `tool_choice`, and it answers only in `tool_calls`. If the passthrough
     * stripped or rewrote any of these fields, Jev would be unusable through
     * the rail. This is a recorded-fixture round-trip in the OpenRouter
     * response shape: no live key involved.
     */
    it('round-trips tools/tool_choice/response_format untouched and returns tool_calls untouched (Jev fixture)', async () => {
      const tools = [{
        type: 'function',
        function: {
          name: 'jev_decision',
          description: 'System One decision schema',
          parameters: { type: 'object', properties: { decision: { type: 'string' } }, required: ['decision'] },
        },
      }];
      const toolChoice = { type: 'function', function: { name: 'jev_decision' } };
      const responseFormat = { type: 'json_schema', json_schema: { name: 'jev_decision', strict: true, schema: { type: 'object' } } };

      // Recorded-fixture OpenRouter response shape: a tool_calls-only
      // completion (no content, no text modality) plus usage.cost.
      const openrouterFixture = {
        id: 'gen-jev-fixture-1',
        object: 'chat.completion',
        model: 'typesafe/jev-1.13',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_jev_1',
              type: 'function',
              function: { name: 'jev_decision', arguments: '{"decision":"proceed"}' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 120, completion_tokens: 14, cost: 0.0000504 },
      };
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify(openrouterFixture), { status: 200, headers: { 'content-type': 'application/json' } }),
      );

      const res = await forwardOpenAiCompatible(
        OPENROUTER_BRAIN,
        { messages: [{ role: 'user', content: 'decide' }], tools, tool_choice: toolChoice, response_format: responseFormat },
        { sessionId: 'sess_jev', turnId: 'turn_jev' },
      );

      const [, init] = fetchMock.mock.calls[0];
      const sentBody = JSON.parse(init.body);
      expect(sentBody.tools).toEqual(tools);
      expect(sentBody.tool_choice).toEqual(toolChoice);
      expect(sentBody.response_format).toEqual(responseFormat);

      const responseBody = await res.json();
      expect(responseBody.choices[0].message.tool_calls).toEqual(openrouterFixture.choices[0].message.tool_calls);

      // Metering used OpenRouter's own usage.cost (#2188), not the local
      // pricing.ts estimate.
      expect(mockRecordInferenceUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'openrouter',
          model: 'typesafe/jev-1.13',
          tokensIn: 120,
          tokensOut: 14,
          explicitCostUsd: 0.0000504,
        }),
      );
    });

    it('forwards OpenRouter provider/model ids untouched as the sealed model', async () => {
      fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));

      await forwardOpenAiCompatible(OPENROUTER_BRAIN, { messages: [] }, {});

      const [, init] = fetchMock.mock.calls[0];
      expect(JSON.parse(init.body).model).toBe('typesafe/jev-1.13');
    });
  });

  describe('externalId + warpRunId capture (#2204 auditor chain view)', () => {
    it('captures the upstream response id as externalId on a non-streaming call', async () => {
      mockRecordInferenceUsage.mockClear();
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'chatcmpl-xyz', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

      await forwardOpenAiCompatible(XAI_BRAIN, { messages: [] }, { sessionId: 'sess-1', turnId: 'turn-1', warpRunId: 'run-1' });

      expect(mockRecordInferenceUsage).toHaveBeenCalledWith(
        expect.objectContaining({ externalId: 'chatcmpl-xyz', sessionId: 'sess-1', turnId: 'turn-1', warpRunId: 'run-1' }),
      );
    });

    it('captures the upstream id from the first SSE chunk that carries one on a streaming call', async () => {
      mockRecordInferenceUsage.mockClear();
      const upstreamStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"id":"chatcmpl-stream-1","choices":[]}\n\n'));
          controller.enqueue(new TextEncoder().encode('data: {"id":"chatcmpl-stream-1","usage":{"prompt_tokens":3,"completion_tokens":4}}\n\n'));
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      fetchMock.mockResolvedValueOnce(
        new Response(upstreamStream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      );

      const res = await forwardOpenAiCompatible(XAI_BRAIN, { messages: [], stream: true }, {});
      await res.text();

      expect(mockRecordInferenceUsage).toHaveBeenCalledWith(
        expect.objectContaining({ externalId: 'chatcmpl-stream-1', tokensIn: 3, tokensOut: 4 }),
      );
    });
  });
});
