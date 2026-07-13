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

// ─── Subject ────────────────────────────────────────────────────────────────

import { infer } from '../policy';
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
  modelProvider: 'openai',
  modelId: 'gemini-2.0-flash',
  systemPrompt: 'You are the AgriFortress engine.',
  resolveConsentTier: (_intentType: string) => 'deliberate',
  resolve: vi.fn(),
};

const MOCK_MODEL = {};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetModel.mockReturnValue(MOCK_MODEL);
  mockUpdateSet.mockImplementation(() => ({ where: mockUpdateSetWhere }));
  mockUpdateSetWhere.mockResolvedValue(undefined);
  mockDbUpdate.mockImplementation(() => ({ set: mockUpdateSet }));
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('infer — inference policy layer', () => {
  it('calls getModel with the vocab modelProvider and modelId', async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: JSON.stringify([{ intentType: 'supply.received', confidence: 0.95, metadata: { product: 'maize' } }]),
    });

    await infer(CTX, VOCAB);

    expect(mockGetModel).toHaveBeenCalledWith('openai', 'gemini-2.0-flash');
  });

  it('calls generateText with the vocab systemPrompt injected', async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: JSON.stringify([{ intentType: 'supply.received', confidence: 0.9, metadata: {} }]),
    });

    await infer(CTX, VOCAB);

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

    await infer(CTX, VOCAB);

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

    const candidates = await infer(CTX, VOCAB);

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

    const candidates = await infer(CTX, VOCAB);

    expect(candidates[0]!.consentTier).toBe('deliberate');
  });

  it('strips markdown code fences from model response', async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: '```json\n[{"intentType":"supply.received","confidence":0.9,"metadata":{}}]\n```',
    });

    const candidates = await infer(CTX, VOCAB);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.intentType).toBe('supply.received');
  });

  it('returns empty array and marks session failed when LLM throws', async () => {
    mockGenerateText.mockRejectedValueOnce(new Error('LLM quota exceeded'));

    await expect(infer(CTX, VOCAB)).rejects.toThrow('Inference policy failed');

    expect(mockUpdateSet).toHaveBeenCalledOnce();
    const setArg = mockUpdateSet.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg['status']).toBe('failed');
  });

  it('returns empty array (no throw) when model response is not valid JSON', async () => {
    mockGenerateText.mockResolvedValueOnce({ text: 'Not JSON at all' });

    const candidates = await infer(CTX, VOCAB);

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

    const candidates = await infer(CTX, VOCAB);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.intentType).toBe('supply.received');
  });

  it('updates session with candidateIntents and status=policy_done on success', async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: JSON.stringify([{ intentType: 'supply.received', confidence: 0.9, metadata: {} }]),
    });

    await infer(CTX, VOCAB);

    expect(mockUpdateSet).toHaveBeenCalledOnce();
    const setArg = mockUpdateSet.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg['status']).toBe('policy_done');
    expect(Array.isArray(setArg['candidateIntents'])).toBe(true);
  });
});
