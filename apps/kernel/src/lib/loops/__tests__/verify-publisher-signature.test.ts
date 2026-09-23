/**
 * Tests for loop.* publisher signature verification (#2295): cryptographic
 * verification against the publisher DID's currently registered key
 * (unknown key, mismatched key, revoked/rotated key, invalid signature,
 * type-binding, and the happy path). Mirrors
 * `notify/__tests__/operator-countersign.test.ts`'s structure exactly,
 * since this module is a direct copy of that precedent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { crypto as authCrypto, canonicalize } from '@imajin/auth';

const PUBLISHER_DID = 'did:imajin:warp-node';

const { mockLimit } = vi.hoisted(() => ({ mockLimit: vi.fn() }));

vi.mock('@/src/db', () => ({
  db: {
    select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: mockLimit }) }) })),
  },
  identities: { id: 'id', publicKey: 'public_key', scope: 'scope', tier: 'tier' },
}));

import { verifyLoopPublisherSignature } from '../verify-publisher-signature';

const FIELDS = {
  type: 'loop.started' as const,
  payload: {
    loopId: 'loop_abc123',
    kind: 'warp.run',
    principal: 'did:imajin:ryan',
    state: 'queued',
    summary: 'Kicked off',
    at: '2026-09-22T00:00:00.000Z',
  },
};

function signFields(privateKeyHex: string, fields = FIELDS): string {
  return authCrypto.signSync(canonicalize(fields), privateKeyHex);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('verifyLoopPublisherSignature', () => {
  it('accepts a valid signature from the publisher DID\'s current registered key (happy path)', async () => {
    const { privateKey, publicKey } = authCrypto.generateKeypair();
    mockLimit.mockResolvedValueOnce([{ id: PUBLISHER_DID, publicKey, type: 'actor', tier: 'established' }]);

    const sig = signFields(privateKey);
    const result = await verifyLoopPublisherSignature(PUBLISHER_DID, FIELDS, {
      keyId: publicKey,
      alg: 'ed25519',
      sig,
    });

    expect(result).toEqual({ ok: true });
  });

  it('rejects when the publisher DID has no resolvable public key (unknown identity)', async () => {
    mockLimit.mockResolvedValueOnce([]);

    const result = await verifyLoopPublisherSignature(PUBLISHER_DID, FIELDS, {
      keyId: 'a'.repeat(64),
      alg: 'ed25519',
      sig: 'b'.repeat(128),
    });

    expect(result.ok).toBe(false);
  });

  it('rejects when keyId does not match the current registered key (unknown/mismatched key)', async () => {
    const { publicKey } = authCrypto.generateKeypair();
    const attacker = authCrypto.generateKeypair();
    mockLimit.mockResolvedValueOnce([{ id: PUBLISHER_DID, publicKey, type: 'actor', tier: 'established' }]);

    const sig = signFields(attacker.privateKey);
    const result = await verifyLoopPublisherSignature(PUBLISHER_DID, FIELDS, {
      keyId: attacker.publicKey,
      alg: 'ed25519',
      sig,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toMatch(/current registered key/);
  });

  it('rejects a signature from a since-rotated (revoked) key', async () => {
    const oldKey = authCrypto.generateKeypair();
    const newKey = authCrypto.generateKeypair();
    mockLimit.mockResolvedValueOnce([{ id: PUBLISHER_DID, publicKey: newKey.publicKey, type: 'actor', tier: 'established' }]);

    const sig = signFields(oldKey.privateKey);
    const result = await verifyLoopPublisherSignature(PUBLISHER_DID, FIELDS, {
      keyId: oldKey.publicKey,
      alg: 'ed25519',
      sig,
    });

    expect(result.ok).toBe(false);
  });

  it('rejects an invalid signature even when keyId matches the current key (forged event)', async () => {
    const { publicKey } = authCrypto.generateKeypair();
    mockLimit.mockResolvedValueOnce([{ id: PUBLISHER_DID, publicKey, type: 'actor', tier: 'established' }]);

    const result = await verifyLoopPublisherSignature(PUBLISHER_DID, FIELDS, {
      keyId: publicKey,
      alg: 'ed25519',
      sig: 'f'.repeat(128),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toBe('Invalid publisher signature');
  });

  it('rejects a signature over a different lifecycle type than the one supplied (binding)', async () => {
    const { privateKey, publicKey } = authCrypto.generateKeypair();
    mockLimit.mockResolvedValueOnce([{ id: PUBLISHER_DID, publicKey, type: 'actor', tier: 'established' }]);

    // Signed as 'loop.finished' but verification is asked to check 'loop.started' —
    // this is exactly the replay this binding prevents.
    const sig = signFields(privateKey, { ...FIELDS, type: 'loop.finished' as const });
    const result = await verifyLoopPublisherSignature(PUBLISHER_DID, FIELDS, {
      keyId: publicKey,
      alg: 'ed25519',
      sig,
    });

    expect(result.ok).toBe(false);
  });

  it('rejects a signature over a different payload than the one supplied (forgery)', async () => {
    const { privateKey, publicKey } = authCrypto.generateKeypair();
    mockLimit.mockResolvedValueOnce([{ id: PUBLISHER_DID, publicKey, type: 'actor', tier: 'established' }]);

    const sig = signFields(privateKey, { ...FIELDS, payload: { ...FIELDS.payload, state: 'succeeded' } });
    const result = await verifyLoopPublisherSignature(PUBLISHER_DID, FIELDS, {
      keyId: publicKey,
      alg: 'ed25519',
      sig,
    });

    expect(result.ok).toBe(false);
  });
});
