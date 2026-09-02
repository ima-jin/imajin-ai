import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetModel, mockGenerateText, mockStreamText } = vi.hoisted(() => ({
  mockGetModel: vi.fn(),
  mockGenerateText: vi.fn(),
  mockStreamText: vi.fn(),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

vi.mock('@imajin/llm', () => ({
  getModel: mockGetModel,
}));

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai');
  return { ...actual, generateText: mockGenerateText, streamText: mockStreamText };
});

const { mockRecordInferenceUsage } = vi.hoisted(() => ({ mockRecordInferenceUsage: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../usage-ledger', () => ({ recordInferenceUsage: mockRecordInferenceUsage }));

import { forwardAnthropic } from '../anthropic-adapter';
import { UpstreamTimeoutError } from '../errors';
import type { ResolvedBrain } from '../../brain';

const ANTHROPIC_BRAIN: ResolvedBrain = {
  connector: 'anthropic',
  credentialDid: 'did:imajin:supplier',
  provider: 'anthropic',
  modelId: 'claude-sonnet-4-20250514',
  apiKey: 'anthropic-secret-key',
};

const FAKE_MODEL = { modelId: 'fake-model' };

describe('forwardAnthropic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetModel.mockReturnValue(FAKE_MODEL);
  });

  it('resolves the model via getModel with the sealed key and no baseURL override', async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: 'hi',
      toolCalls: [],
      finishReason: 'stop',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });

    await forwardAnthropic(ANTHROPIC_BRAIN, { messages: [{ role: 'user', content: 'hi' }] }, {});

    expect(mockGetModel).toHaveBeenCalledWith('anthropic', 'claude-sonnet-4-20250514', { apiKey: 'anthropic-secret-key' });
  });

  describe('non-streaming', () => {
    it('calls generateText and returns a chat.completion JSON response', async () => {
      mockGenerateText.mockResolvedValueOnce({
        text: 'hello!',
        toolCalls: [],
        finishReason: 'stop',
        usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
      });

      const res = await forwardAnthropic(
        ANTHROPIC_BRAIN,
        { messages: [{ role: 'user', content: 'hi' }] },
        { sessionId: 'sess_1', turnId: 'turn_1' },
      );

      expect(mockStreamText).not.toHaveBeenCalled();
      expect(mockGenerateText).toHaveBeenCalledTimes(1);
      const callArgs = mockGenerateText.mock.calls[0][0];
      expect(callArgs.model).toBe(FAKE_MODEL);
      expect(callArgs.messages).toEqual([{ role: 'user', content: 'hi' }]);

      expect(res.headers.get('Content-Type')).toBe('application/json');
      const body = await res.json();
      expect(body).toMatchObject({
        object: 'chat.completion',
        model: 'claude-sonnet-4-20250514',
        choices: [{ message: { role: 'assistant', content: 'hello!' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      });
    });

    it('forwards max_tokens and temperature from the request body', async () => {
      mockGenerateText.mockResolvedValueOnce({
        text: 'ok',
        toolCalls: [],
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      });

      await forwardAnthropic(
        ANTHROPIC_BRAIN,
        { messages: [], max_tokens: 256, temperature: 0.2 },
        {},
      );

      const callArgs = mockGenerateText.mock.calls[0][0];
      expect(callArgs.maxTokens).toBe(256);
      expect(callArgs.temperature).toBe(0.2);
    });

    it('translates an aborted generateText call into UpstreamTimeoutError', async () => {
      const abortErr = new Error('This operation was aborted');
      abortErr.name = 'TimeoutError';
      mockGenerateText.mockRejectedValueOnce(abortErr);

      await expect(forwardAnthropic(ANTHROPIC_BRAIN, { messages: [] }, {})).rejects.toBeInstanceOf(UpstreamTimeoutError);
    });

    it('rethrows a non-timeout generateText failure untouched', async () => {
      mockGenerateText.mockRejectedValueOnce(new Error('rate limited'));

      await expect(forwardAnthropic(ANTHROPIC_BRAIN, { messages: [] }, {})).rejects.toThrow('rate limited');
    });
  });

  describe('streaming', () => {
    async function* fakeFullStream() {
      yield { type: 'text-delta', textDelta: 'Hel' };
      yield { type: 'text-delta', textDelta: 'lo' };
      yield { type: 'finish', finishReason: 'stop', usage: { promptTokens: 4, completionTokens: 6, totalTokens: 10 } };
    }

    it('calls streamText with toolCallStreaming enabled and returns an SSE Response', async () => {
      mockStreamText.mockReturnValueOnce({ fullStream: fakeFullStream() });

      const res = await forwardAnthropic(ANTHROPIC_BRAIN, { messages: [{ role: 'user', content: 'hi' }], stream: true }, {});

      expect(mockGenerateText).not.toHaveBeenCalled();
      const callArgs = mockStreamText.mock.calls[0][0];
      expect(callArgs.toolCallStreaming).toBe(true);

      expect(res.headers.get('Content-Type')).toBe('text/event-stream');
      const text = await res.text();
      expect(text).toContain('"content":"Hel"');
      expect(text).toContain('"content":"lo"');
      expect(text).toContain('"finish_reason":"stop"');
      expect(text).toContain('data: [DONE]');
    });

    it('emits a graceful error frame and still terminates with [DONE] when the stream throws mid-flight', async () => {
      async function* throwingStream(): AsyncGenerator<unknown> {
        yield { type: 'text-delta', textDelta: 'partial' };
        throw new Error('connection reset');
      }
      mockStreamText.mockReturnValueOnce({ fullStream: throwingStream() });

      const res = await forwardAnthropic(ANTHROPIC_BRAIN, { messages: [], stream: true }, {});
      const text = await res.text();

      expect(text).toContain('"content":"partial"');
      expect(text).toContain('upstream_error');
      expect(text).toContain('data: [DONE]');
    });
  });
});
