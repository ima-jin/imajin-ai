/**
 * Tests for loop.* publisher signature verification (#2295): cryptographic
 * verification against the publisher DID's currently registered key
 * (unknown key, mismatched key, revoked/rotated key, invalid signature,
 * type-binding, and the happy path). Mirrors
 * `notify/__tests__/operator-countersign.test.ts`'s structure exactly,
 * since this module is a direct copy of that precedent.
 *
 * Also covers the #2338 in-process node-key resolver: a `publisherDid`
 * equal to the kernel's own signing DID (`getNodeSigningIdentity()`)
 * verifies directly against its pubkey with no registry round-trip, while
 * every other DID keeps resolving through `createDbResolver` exactly as
 * before.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { crypto as authCrypto, canonicalize } from '@imajin/auth';

const PUBLISHER_DID = 'did:imajin:warp-node';

const { mockLimit, getNodeSigningIdentityMock } = vi.hoisted(() => ({
  mockLimit: vi.fn(),
  getNodeSigningIdentityMock: vi.fn(),
}));

vi.mock('@/src/db', () => ({
  db: {
    select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: mockLimit }) }) })),
  },
  identities: { id: 'id', publicKey: 'public_key', scope: 'scope', tier: 'tier' },
}));

vi.mock('@/src/lib/vault/sealing', () => ({
  getNodeSigningIdentity: getNodeSigningIdentityMock,
}));

import { verifyLoopPublisherSignature } from '../verify-publisher-signature';

const NODE_DID = 'did:imajin:79d90672eb5b176d';

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

const NODE_KEYPAIR = authCrypto.generateKeypair();

beforeEach(() => {
  vi.clearAllMocks();
  getNodeSigningIdentityMock.mockReturnValue({
    privateKeyHex: NODE_KEYPAIR.privateKey,
    senderPubkey: NODE_KEYPAIR.publicKey,
    senderDid: NODE_DID,
  });
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

  describe('node-signed publisher (#2338 in-process resolver)', () => {
    it('accepts a node-signed loop event via the in-process resolver, with no registry lookup', async () => {
      const sig = signFields(NODE_KEYPAIR.privateKey);
      const result = await verifyLoopPublisherSignature(NODE_DID, FIELDS, {
        keyId: NODE_KEYPAIR.publicKey,
        alg: 'ed25519',
        sig,
      });

      expect(result).toEqual({ ok: true });
      expect(mockLimit).not.toHaveBeenCalled();
    });

    it('still resolves a foreign (non-node) DID via the identity registry', async () => {
      const { privateKey, publicKey } = authCrypto.generateKeypair();
      mockLimit.mockResolvedValueOnce([{ id: PUBLISHER_DID, publicKey, type: 'actor', tier: 'established' }]);

      const sig = signFields(privateKey);
      const result = await verifyLoopPublisherSignature(PUBLISHER_DID, FIELDS, {
        keyId: publicKey,
        alg: 'ed25519',
        sig,
      });

      expect(result).toEqual({ ok: true });
      expect(mockLimit).toHaveBeenCalledTimes(1);
    });

    it('rejects a spoofed DID carrying the node prefix but signed with the wrong key', async () => {
      const attacker = authCrypto.generateKeypair();

      const sig = signFields(attacker.privateKey);
      const result = await verifyLoopPublisherSignature(NODE_DID, FIELDS, {
        keyId: attacker.publicKey,
        alg: 'ed25519',
        sig,
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.error).toMatch(/current registered key/);
      // The forged keyId never gets a chance to swap in for the node's real
      // pubkey — resolution is in-process, so the registry is never consulted.
      expect(mockLimit).not.toHaveBeenCalled();
    });

    it('rejects a spoofed node DID with a forged signature even when keyId matches the real node pubkey', async () => {
      const result = await verifyLoopPublisherSignature(NODE_DID, FIELDS, {
        keyId: NODE_KEYPAIR.publicKey,
        alg: 'ed25519',
        sig: 'f'.repeat(128),
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.error).toBe('Invalid publisher signature');
    });
  });
});
