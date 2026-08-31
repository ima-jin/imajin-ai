import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const { mockUpdateSetWhere, mockUpdateSet, mockDbUpdate } = vi.hoisted(() => {
  const mockUpdateSetWhere = vi.fn().mockResolvedValue(undefined);
  const mockUpdateSet = vi.fn(() => ({ where: mockUpdateSetWhere }));
  const mockDbUpdate = vi.fn(() => ({ set: mockUpdateSet }));
  return { mockUpdateSetWhere, mockUpdateSet, mockDbUpdate };
});

vi.mock('@/src/db', () => ({
  db: { update: mockDbUpdate },
  inferenceSessions: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({ type: 'eq' })),
}));

const mockGetModel = vi.hoisted(() => vi.fn());
const mockGenerateText = vi.hoisted(() => vi.fn());
vi.mock('@imajin/llm', () => ({
  getModel: mockGetModel,
  generateText: mockGenerateText,
}));

vi.mock('@imajin/logger', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() })),
}));

const mockResolveBrain = vi.hoisted(() => vi.fn());
vi.mock('../brain', () => {
  // #1818: real class (no DB/vault imports, unlike the rest of brain.ts), so
  // policy.ts's `new ModelDeprecatedError(...)` and this test's
  // `instanceof ModelDeprecatedError` refer to the exact same constructor.
  class ModelDeprecatedError extends Error {
    readonly connector: string;
    readonly modelId: string;
    constructor(connector: string, modelId: string) {
      super(`model_deprecated: ${connector} model '${modelId}' was not found upstream`);
      this.name = 'ModelDeprecatedError';
      this.connector = connector;
      this.modelId = modelId;
    }
  }
  return { resolveBrain: mockResolveBrain, ModelDeprecatedError };
});

// ─── Subject ────────────────────────────────────

import { APICallError } from 'ai';
import { infer } from '../policy';
import { ModelDeprecatedError } from '../brain';
import type { InferenceContext, IntentVocabulary } from '../types';

// ─── Helpers ────────────────────────────────────────────────────────────────

const CTX: InferenceContext = {
  sessionId: 'session_test',
  assetId: 'asset_test',
  transcript: 'received 50 bags of maize seed from Eric',
  priors: {
    recentConnectionDids: ['did:imajin:eric'],
    timeOfDay: 'morning',
    recentActivitySummary: '',
  },
};

const VOCAB: IntentVocabulary = {
  name: 'agrifortress',
  systemPrompt: 'You are the AgriFortress engine.',
  resolveConsentTier: (_intentType: string) => 'deliberate',
  resolve: vi.fn(),
};

const OWNER = 'did:imajin:farmer';

const GEMINI_BRAIN = {
  connector: 'gemini' as const,
  credentialDid: OWNER,
  provider: 'openai' as const,
  modelId: 'gemini-2.0-flash',
  apiKey: 'AIzaSy-SEALED',
  baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
};

const MOCK_MODEL = {};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetModel.mockReturnValue(MOCK_MODEL);
  mockUpdateSet.mockImplementation(() => ({ where: mockUpdateSetWhere }));
  mockUpdateSetWhere.mockResolvedValue(undefined);
  mockDbUpdate.mockImplementation(() => ({ set: mockUpdateSet }));
  mockResolveBrain.mockResolvedValue(GEMINI_BRAIN);
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('infer — inference policy layer', () => {
  /**
   * #1621: the model comes from the acting DID's sealed connection, never from
   * the vocabulary and never from an env var. The vocab no longer carries
   * modelProvider/modelId at all.
   */
  it('builds the model from the brain resolved for the acting DID', async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: JSON.stringify([{ intentType: 'supply.received', confidence: 0.95, metadata: { product: 'maize' } }]),
    });

    await infer(CTX, VOCAB, OWNER);

    expect(mockResolveBrain).toHaveBeenCalledWith(OWNER);
    expect(mockGetModel).toHaveBeenCalledWith('openai', 'gemini-2.0-flash', {
      apiKey: 'AIzaSy-SEALED',
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    });
  });

  it('drives whichever provider the owner sealed', async () => {
    mockResolveBrain.mockResolvedValueOnce({
      connector: 'anthropic',
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-20250514',
      apiKey: 'sk-ant-SEALED',
    });
    mockGenerateText.mockResolvedValueOnce({
      text: JSON.stringify([{ intentType: 'supply.received', confidence: 0.9, metadata: {} }]),
    });

    await infer(CTX, VOCAB, OWNER);

    expect(mockGetModel).toHaveBeenCalledWith('anthropic', 'claude-sonnet-4-20250514', {
      apiKey: 'sk-ant-SEALED',
    });
  });

  /**
   * #1624: an app/org DID may supply the credential. `infer` forwards the whole
   * context and lets the resolver decide the walk order — which DID actually
   * wins is asserted in brain.test.ts, the module that owns that policy.
   */
  it('forwards the owner and app DID context to the resolver', async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: JSON.stringify([{ intentType: 'supply.received', confidence: 0.9, metadata: {} }]),
    });

    await infer(CTX, VOCAB, { ownerDid: OWNER, appDid: 'did:imajin:agrifortress' });

    expect(mockResolveBrain).toHaveBeenCalledWith({
      ownerDid: OWNER,
      appDid: 'did:imajin:agrifortress',
    });
  });

  it('accepts a bare owner DID string, keeping the MCP call site unchanged', async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: JSON.stringify([{ intentType: 'supply.received', confidence: 0.9, metadata: {} }]),
    });

    await infer(CTX, VOCAB, OWNER);

    expect(mockResolveBrain).toHaveBeenCalledWith(OWNER);
  });

  it('marks the session failed when no DID has sealed a brain', async () => {
    const noBrain = new Error('inference_no_brain: nothing sealed');
    mockResolveBrain.mockRejectedValueOnce(noBrain);

    // #1764: the original error propagates unwrapped, so the capture route
    // can match on its identity (e.g. instanceof NoBrainSealedError) instead
    // of parsing a generic wrapped message.
    await expect(infer(CTX, VOCAB, OWNER)).rejects.toBe(noBrain);

    expect(mockGenerateText).not.toHaveBeenCalled();
    const setArg = mockUpdateSet.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg['status']).toBe('failed');
  });

  it('calls generateText with the vocab systemPrompt injected', async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: JSON.stringify([{ intentType: 'supply.received', confidence: 0.9, metadata: {} }]),
    });

    await infer(CTX, VOCAB, OWNER);

    expect(mockGenerateText).toHaveBeenCalledOnce();
    const args = mockGenerateText.mock.calls[0][0] as { system?: string; prompt?: string };
    expect(args.system).toContain('AgriFortress');
    expect(args.prompt).toContain('received 50 bags of maize seed from Eric');
    expect(args.prompt).toContain('morning');
  });

  it('includes recent connection DIDs in the prompt', async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: JSON.stringify([{ intentType: 'supply.received', confidence: 0.8, metadata: {} }]),
    });

    await infer(CTX, VOCAB, OWNER);

    const args = mockGenerateText.mock.calls[0][0] as { prompt?: string };
    expect(args.prompt).toContain('did:imajin:eric');
  });

  it('parses the JSON response and returns ranked CandidateIntent[]', async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: JSON.stringify([
        { intentType: 'supply.received', confidence: 0.95, metadata: { product: 'maize', qty: 50 } },
        { intentType: 'lot.opened', confidence: 0.3, metadata: {} },
      ]),
    });

    const candidates = await infer(CTX, VOCAB, OWNER);

    expect(candidates).toHaveLength(2);
    expect(candidates[0]!.intentType).toBe('supply.received');
    expect(candidates[0]!.confidence).toBe(0.95);
    expect(candidates[0]!.metadata['product']).toBe('maize');
    // Results are sorted by confidence descending.
    expect(candidates[0]!.confidence).toBeGreaterThan(candidates[1]!.confidence);
  });

  it('enriches each candidate with consentTier from vocab.resolveConsentTier', async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: JSON.stringify([{ intentType: 'supply.received', confidence: 0.9, metadata: {} }]),
    });

    const candidates = await infer(CTX, VOCAB, OWNER);

    expect(candidates[0]!.consentTier).toBe('deliberate');
  });

  it('strips markdown code fences from model response', async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: '```json\n[{"intentType":"supply.received","confidence":0.9,"metadata":{}}]\n```',
    });

    const candidates = await infer(CTX, VOCAB, OWNER);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.intentType).toBe('supply.received');
  });

  it('returns empty array and marks session failed when LLM throws', async () => {
    const llmError = new Error('LLM quota exceeded');
    mockGenerateText.mockRejectedValueOnce(llmError);

    await expect(infer(CTX, VOCAB, OWNER)).rejects.toBe(llmError);

    expect(mockUpdateSet).toHaveBeenCalledOnce();
    const setArg = mockUpdateSet.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg['status']).toBe('failed');
  });

  /**
   * #1818: the model sealed on a connector card can be retired upstream
   * after selection — Google's own ListModels API keeps listing dead models,
   * so a 404 on the actual chat-completions call is the only reliable
   * signal. This must surface as a distinctly-typed `ModelDeprecatedError`
   * naming the connector/model, not the original opaque provider error, so
   * the capture route can map it to 422 model_deprecated instead of a bare
   * 500.
   */
  describe('when the provider reports the sealed model as not found (#1818)', () => {
    it('throws ModelDeprecatedError naming the connector and model, and marks the session failed', async () => {
      const notFound = new APICallError({
        message: 'Not Found',
        url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
        requestBodyValues: {},
        statusCode: 404,
        isRetryable: false,
      });
      mockGenerateText.mockRejectedValueOnce(notFound);

      const thrown = await infer(CTX, VOCAB, OWNER).catch((err: unknown) => err);

      expect(thrown).toBeInstanceOf(ModelDeprecatedError);
      expect((thrown as InstanceType<typeof ModelDeprecatedError>).connector).toBe('gemini');
      expect((thrown as InstanceType<typeof ModelDeprecatedError>).modelId).toBe('gemini-2.0-flash');

      const setArg = mockUpdateSet.mock.calls[0][0] as Record<string, unknown>;
      expect(setArg['status']).toBe('failed');
    });

    it('also maps a 404 that only surfaces as a "not found" message with no statusCode', async () => {
      const notFound = new APICallError({
        message: 'The model `gemini-2.0-flash` was Not Found',
        url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
        requestBodyValues: {},
        isRetryable: false,
      });
      mockGenerateText.mockRejectedValueOnce(notFound);

      await expect(infer(CTX, VOCAB, OWNER)).rejects.toBeInstanceOf(ModelDeprecatedError);
    });

    it('does not reclassify a non-404 APICallError (e.g. a genuine 429) as model_deprecated', async () => {
      const rateLimited = new APICallError({
        message: 'Too Many Requests',
        url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
        requestBodyValues: {},
        statusCode: 429,
        isRetryable: true,
      });
      mockGenerateText.mockRejectedValueOnce(rateLimited);

      await expect(infer(CTX, VOCAB, OWNER)).rejects.toBe(rateLimited);
    });
  });

  /**
   * #1764: the default AI SDK retry count (2, i.e. 3 attempts) amplifies a
   * single user request into three upstream calls, which is how one request
   * produced "Failed after 3 attempts" against a rate-limited/decommissioned
   * model. Capping it here means one policy call is at most two upstream
   * attempts.
   */
  it('caps generateText retries so one call cannot fan out into three upstream attempts', async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: JSON.stringify([{ intentType: 'supply.received', confidence: 0.9, metadata: {} }]),
    });

    await infer(CTX, VOCAB, OWNER);

    const args = mockGenerateText.mock.calls[0][0] as { maxRetries?: number };
    expect(args.maxRetries).toBe(1);
  });

  it('returns empty array (no throw) when model response is not valid JSON', async () => {
    mockGenerateText.mockResolvedValueOnce({ text: 'Not JSON at all' });

    const candidates = await infer(CTX, VOCAB, OWNER);

    expect(candidates).toEqual([]);
  });

  it('filters out candidates where intentType is an object (not a string)', async () => {
    // S6551: String({nested: 'x'}) === '[object Object]' — the guard must reject non-strings.
    mockGenerateText.mockResolvedValueOnce({
      text: JSON.stringify([
        { intentType: { nested: 'object' }, confidence: 0.95, metadata: {} },
        { intentType: 'supply.received', confidence: 0.7, metadata: {} },
      ]),
    });

    const candidates = await infer(CTX, VOCAB, OWNER);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.intentType).toBe('supply.received');
  });

  it('updates session with candidateIntents and status=policy_done on success', async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: JSON.stringify([{ intentType: 'supply.received', confidence: 0.9, metadata: {} }]),
    });

    await infer(CTX, VOCAB, OWNER);

    expect(mockUpdateSet).toHaveBeenCalledOnce();
    const setArg = mockUpdateSet.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg['status']).toBe('policy_done');
    expect(Array.isArray(setArg['candidateIntents'])).toBe(true);
  });
});
