import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockListAnthropicOwners, mockLoadAnthropicCreds,
  mockListOpenaiOwners, mockLoadOpenaiCreds,
  mockCreateAnthropicReader, mockCreateOpenAIReader,
  mockIngestBilledUsage,
  mockAnthropicFetch, mockOpenAIFetch,
} = vi.hoisted(() => ({
  mockListAnthropicOwners: vi.fn(),
  mockLoadAnthropicCreds: vi.fn(),
  mockListOpenaiOwners: vi.fn(),
  mockLoadOpenaiCreds: vi.fn(),
  mockCreateAnthropicReader: vi.fn(),
  mockCreateOpenAIReader: vi.fn(),
  mockIngestBilledUsage: vi.fn(),
  mockAnthropicFetch: vi.fn(),
  mockOpenAIFetch: vi.fn(),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('@/src/lib/anthropic/billing-connector', () => ({
  listBillingGrantOwners: mockListAnthropicOwners,
  loadAnthropicBillingCredentials: mockLoadAnthropicCreds,
}));
vi.mock('@/src/lib/openai/billing-connector', () => ({
  listBillingGrantOwners: mockListOpenaiOwners,
  loadOpenaiBillingCredentials: mockLoadOpenaiCreds,
}));
vi.mock('../anthropic', () => ({ createAnthropicBilledUsageReader: mockCreateAnthropicReader }));
vi.mock('../openai', () => ({ createOpenAIBilledUsageReader: mockCreateOpenAIReader }));
vi.mock('../ingest', () => ({ ingestBilledUsage: mockIngestBilledUsage }));

import { runBilledUsageIngestion } from '../ingest-job';
import { BillingApiError } from '../types';

const OWNER_A = 'did:imajin:alice';
const OWNER_B = 'did:imajin:bob';
const NOW = new Date('2026-08-15T12:00:00Z');

describe('runBilledUsageIngestion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateAnthropicReader.mockImplementation(() => ({ provider: 'anthropic', fetch: mockAnthropicFetch }));
    mockCreateOpenAIReader.mockImplementation(() => ({ provider: 'openai', fetch: mockOpenAIFetch }));
    mockIngestBilledUsage.mockImplementation(async ({ lines }: { lines: unknown[] }) => lines.length);
  });

  it('pulls yesterday + month-to-date for every owner with an active grant, per provider', async () => {
    mockListAnthropicOwners.mockResolvedValue([OWNER_A]);
    mockListOpenaiOwners.mockResolvedValue([]);
    mockLoadAnthropicCreds.mockResolvedValue({ apiKey: 'sk-ant-admin-x' });
    mockAnthropicFetch.mockResolvedValue([{ model: 'claude-opus-5', tokensIn: 1, tokensOut: 1, billedUsd: 1, raw: {} }]);

    const result = await runBilledUsageIngestion(NOW);

    expect(mockAnthropicFetch).toHaveBeenCalledTimes(2); // day + month
    const granularities = mockAnthropicFetch.mock.calls.map((call) => call[1]);
    expect(granularities.sort()).toEqual(['day', 'month']);
    expect(result.owners).toBe(1);
    expect(result.results).toHaveLength(2);
    expect(result.failures).toEqual([]);
  });

  it('iterates every provider independently and every owner within it', async () => {
    mockListAnthropicOwners.mockResolvedValue([OWNER_A]);
    mockListOpenaiOwners.mockResolvedValue([OWNER_B]);
    mockLoadAnthropicCreds.mockResolvedValue({ apiKey: 'sk-ant-admin-x' });
    mockLoadOpenaiCreds.mockResolvedValue({ apiKey: 'sk-admin-y' });
    mockAnthropicFetch.mockResolvedValue([]);
    mockOpenAIFetch.mockResolvedValue([]);

    const result = await runBilledUsageIngestion(NOW);

    expect(result.owners).toBe(2);
    expect(mockAnthropicFetch).toHaveBeenCalledTimes(2);
    expect(mockOpenAIFetch).toHaveBeenCalledTimes(2);
  });

  it('skips an owner+provider pull fail-open on a 401/403 BillingApiError without aborting the sweep', async () => {
    mockListAnthropicOwners.mockResolvedValue([OWNER_A]);
    mockListOpenaiOwners.mockResolvedValue([OWNER_B]);
    mockLoadAnthropicCreds.mockResolvedValue({ apiKey: 'sk-ant-admin-bad' });
    mockLoadOpenaiCreds.mockResolvedValue({ apiKey: 'sk-admin-y' });
    mockAnthropicFetch.mockRejectedValue(new BillingApiError('anthropic', 401, 'no admin key'));
    mockOpenAIFetch.mockResolvedValue([{ model: 'gpt-5.5', tokensIn: 1, tokensOut: 1, billedUsd: null, raw: {} }]);

    const result = await runBilledUsageIngestion(NOW);

    // Anthropic's owner failed both pulls (day + month), OpenAI's owner still succeeded.
    expect(result.failures).toHaveLength(2);
    expect(result.failures.every((f) => f.provider === 'anthropic' && f.authError)).toBe(true);
    expect(result.results).toHaveLength(2);
    expect(result.results.every((r) => r.provider === 'openai')).toBe(true);
  });

  it('collects a non-auth failure without aborting the rest of the sweep', async () => {
    mockListAnthropicOwners.mockResolvedValue([OWNER_A]);
    mockListOpenaiOwners.mockResolvedValue([]);
    mockLoadAnthropicCreds.mockResolvedValue({ apiKey: 'sk-ant-admin-x' });
    mockAnthropicFetch
      .mockRejectedValueOnce(new Error('upstream 500'))
      .mockResolvedValueOnce([]);

    const result = await runBilledUsageIngestion(NOW);

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ provider: 'anthropic', authError: false });
    expect(result.results).toHaveLength(1);
  });

  it('skips an owner with an active grant but no sealed admin key, without failing', async () => {
    mockListAnthropicOwners.mockResolvedValue([OWNER_A]);
    mockListOpenaiOwners.mockResolvedValue([]);
    mockLoadAnthropicCreds.mockResolvedValue(undefined);

    const result = await runBilledUsageIngestion(NOW);

    expect(mockAnthropicFetch).not.toHaveBeenCalled();
    expect(result.results).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(result.owners).toBe(1);
  });

  it('skips the whole provider (without crashing) when enumerating owners fails', async () => {
    mockListAnthropicOwners.mockRejectedValue(new Error('DB connection lost'));
    mockListOpenaiOwners.mockResolvedValue([OWNER_B]);
    mockLoadOpenaiCreds.mockResolvedValue({ apiKey: 'sk-admin-y' });
    mockOpenAIFetch.mockResolvedValue([]);

    const result = await runBilledUsageIngestion(NOW);

    expect(result.owners).toBe(1);
    expect(result.results).toHaveLength(2);
    expect(result.failures).toEqual([]);
  });
});
