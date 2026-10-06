import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { imajinVocabulary } from '../imajin';
import type { CandidateIntent } from '../contract';

function candidate(intentType: string): CandidateIntent {
  return {
    intentType,
    confidence: 0.9,
    metadata: {},
    consentTier: imajinVocabulary.resolveConsentTier(intentType),
  };
}

describe('imajinVocabulary.resolveConsentTier', () => {
  it.each([
    ['note.self', 'silent'],
    ['receipt.file', 'silent'],
    ['discovery.context', 'silent'],
    ['message.connection', 'deliberate'],
    ['asset.share', 'deliberate'],
  ])('classifies the pre-Revocation intent %s as %s', (intentType, tier) => {
    expect(imajinVocabulary.resolveConsentTier(intentType)).toBe(tier);
  });

  describe('revoke.* family (#2027 — Revocation, the sixth primitive)', () => {
    it("classifies revoke.withdraw as 'silent' (stops future participation; the past record stands)", () => {
      expect(imajinVocabulary.resolveConsentTier('revoke.withdraw')).toBe('silent');
    });

    it.each(['revoke.tombstone', 'revoke.destroy', 'revoke.propagate'])(
      "classifies %s as 'deliberate' (boundary-crossing — it acts on validity of a shared record)",
      (intentType) => {
        expect(imajinVocabulary.resolveConsentTier(intentType)).toBe('deliberate');
      },
    );
  });
});

describe('imajinVocabulary.resolve (stub reference implementation)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-05T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(['revoke.withdraw', 'revoke.tombstone', 'revoke.destroy', 'revoke.propagate'])(
    'produces a stub resolution receipt for %s without wiring a real handler',
    async (intentType) => {
      const receipt = await imajinVocabulary.resolve(candidate(intentType), 'did:imajin:owner');

      expect(receipt).toEqual({
        primitiveType: intentType,
        digest: expect.any(String),
        resolvedAt: '2026-09-05T00:00:00.000Z',
      });
      // No real primitive is wired yet — Revocation is named ahead of the
      // lived experience (#2027), so resolve() must not surface an
      // externalId that would imply a tombstone store, key-destruction
      // path, or propagation transport actually ran.
      expect(receipt.externalId).toBeUndefined();
    },
  );

  it('produces different digests for different revoke.* intent types', async () => {
    const withdraw = await imajinVocabulary.resolve(candidate('revoke.withdraw'), 'did:imajin:owner');
    const tombstone = await imajinVocabulary.resolve(candidate('revoke.tombstone'), 'did:imajin:owner');

    expect(withdraw.digest).not.toBe(tombstone.digest);
  });

  it('rejects (rather than throwing synchronously) when the intent cannot be digested', async () => {
    const unserialisable = { ...candidate('revoke.withdraw'), metadata: { n: BigInt(1) } };

    let pending: Promise<unknown> | undefined;
    expect(() => {
      pending = imajinVocabulary.resolve(unserialisable, 'did:imajin:owner');
    }).not.toThrow();
    await expect(pending).rejects.toThrow(TypeError);
  });
});
