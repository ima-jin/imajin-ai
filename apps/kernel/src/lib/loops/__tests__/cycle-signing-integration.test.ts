/**
 * Integration test for `cycle.ts`'s signing (#2314): unlike `cycle.test.ts`
 * (which mocks `ingestLoopEvent` directly), this file leaves `ingestLoopEvent`
 * and `verifyLoopPublisherSignature` real, mocking only `@imajin/bus`'s
 * `publish` (so nothing touches a real bus) and the DB identity resolver
 * (`@/src/db`, same shape as `verify-publisher-signature.test.ts`). This
 * proves the envelope + signature `cycle.ts` produces actually verifies
 * through the existing rail, not just that it calls a mock with the right
 * shape.
 *
 * `startCycle` is used because it is the one call that needs no
 * `kernel.loops` lookup of its own (no prior cycle to resolve), keeping
 * this file's mocking surface to exactly the two things that must stay
 * real: the node signing keypair and the ed25519 verify path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { crypto as authCrypto } from '@imajin/auth';

const NODE_DID = 'did:imajin:node-witness';

const { getNodeSigningIdentityMock, mockLimit, mockPublish } = vi.hoisted(() => ({
  getNodeSigningIdentityMock: vi.fn(),
  mockLimit: vi.fn(),
  mockPublish: vi.fn(),
}));

vi.mock('@/src/lib/vault/sealing', () => ({
  getNodeSigningIdentity: getNodeSigningIdentityMock,
}));

vi.mock('@/src/db', () => ({
  db: {
    select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: mockLimit }) }) })),
  },
  identities: { id: 'id', publicKey: 'public_key', scope: 'scope', tier: 'tier' },
}));

vi.mock('@imajin/bus', () => ({
  publish: mockPublish,
}));

import { startCycle } from '../cycle';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('cycle.ts signing (real verify-publisher-signature path)', () => {
  it('produces a signature that verifies against the node identity\u2019s registered public key', async () => {
    const { privateKey, publicKey } = authCrypto.generateKeypair();
    getNodeSigningIdentityMock.mockReturnValue({
      privateKeyHex: privateKey,
      senderPubkey: publicKey,
      senderDid: NODE_DID,
    });
    mockLimit.mockResolvedValueOnce([{ id: NODE_DID, publicKey, type: 'actor', tier: 'established' }]);
    mockPublish.mockResolvedValueOnce(undefined);

    const result = await startCycle({
      principal: 'did:imajin:ryan',
      trigger: 'chat',
      plannedPhases: ['merge-sweep', 'raise', 'provision', 'review', 'report'],
    });

    expect(result.ok).toBe(true);
    // The real ingestLoopEvent only reaches bus.publish once signature
    // verification (also real here) has actually succeeded.
    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish).toHaveBeenCalledWith(
      'loop.started',
      expect.objectContaining({ issuer: NODE_DID, subject: 'did:imajin:ryan', scope: 'loop' }),
    );
  });

  it('fails closed (no publish) when the signing identity\u2019s key does not match what is registered', async () => {
    const nodeKeypair = authCrypto.generateKeypair();
    const registeredKeypair = authCrypto.generateKeypair();
    getNodeSigningIdentityMock.mockReturnValue({
      privateKeyHex: nodeKeypair.privateKey,
      senderPubkey: nodeKeypair.publicKey,
      senderDid: NODE_DID,
    });
    // The DID resolves to a DIFFERENT registered key than the one signing here
    // (e.g. a rotated/stale identity) — verification must reject it.
    mockLimit.mockResolvedValueOnce([{ id: NODE_DID, publicKey: registeredKeypair.publicKey, type: 'actor', tier: 'established' }]);

    const result = await startCycle({ principal: 'did:imajin:ryan', trigger: 'automation', plannedPhases: ['merge-sweep'] });

    expect(result.ok).toBe(false);
    expect(mockPublish).not.toHaveBeenCalled();
  });
});
