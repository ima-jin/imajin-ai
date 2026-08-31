import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agrifortressVocabulary } from '../agrifortress';
import type { CandidateIntent } from '../contract';

const SUPPLY_INTENT: CandidateIntent = {
  intentType: 'supply.received',
  confidence: 0.95,
  metadata: { product: 'maize', qty: 50 },
  consentTier: 'deliberate',
};

describe('agrifortressVocabulary.resolve (#1850)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-31T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('returns an attestation-only stub receipt', async () => {
    const receipt = await agrifortressVocabulary.resolve(
      SUPPLY_INTENT,
      'did:imajin:farmer',
    );

    expect(receipt).toEqual({
      primitiveType: 'supply.received',
      digest: 'f8675e650e3d1e6013d4520e34bfc2cc1baaad2c570e9a8d0c92c36e6fb89819',
      resolvedAt: '2026-08-31T12:00:00.000Z',
    });
    expect(receipt.externalId).toBeUndefined();
  });

  it('does not call a supply API when xprize-only env vars are set', async () => {
    vi.stubEnv('AGRIFORTRESS_SUPPLY_API_URL', 'https://jin.imajin.ai');
    vi.stubEnv('AGRIFORTRESS_SUPPLY_API_KEY', 'test-key');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const receipt = await agrifortressVocabulary.resolve(
      SUPPLY_INTENT,
      'did:imajin:farmer',
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(receipt.externalId).toBeUndefined();
  });

  it('includes the confirmed intent metadata and owner in the receipt digest', async () => {
    const original = await agrifortressVocabulary.resolve(
      SUPPLY_INTENT,
      'did:imajin:farmer',
    );
    const edited = await agrifortressVocabulary.resolve(
      { ...SUPPLY_INTENT, metadata: { product: 'seed', qty: 10 } },
      'did:imajin:farmer',
    );
    const otherOwner = await agrifortressVocabulary.resolve(
      SUPPLY_INTENT,
      'did:imajin:other',
    );

    expect(edited.digest).not.toBe(original.digest);
    expect(otherOwner.digest).not.toBe(original.digest);
  });
});
