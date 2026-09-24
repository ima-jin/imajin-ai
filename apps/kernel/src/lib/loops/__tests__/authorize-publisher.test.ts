/**
 * Tests for `authorizeLoopPublisher` (#2358) — the publisher-authorization
 * gate that runs after signature verification and before publish. `grants`
 * (`introspectGrant`) and `getNodeSigningIdentity` are mocked so these tests
 * pin the three accepted paths (self-attestation, node witness, active
 * grant) and the fail-closed default without touching a real DB or vault.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockIntrospectGrant, mockGetNodeSigningIdentity } = vi.hoisted(() => ({
  mockIntrospectGrant: vi.fn(),
  mockGetNodeSigningIdentity: vi.fn(),
}));

vi.mock('@/src/lib/auth/grants', () => ({
  introspectGrant: mockIntrospectGrant,
}));

vi.mock('@/src/lib/vault/sealing', () => ({
  getNodeSigningIdentity: mockGetNodeSigningIdentity,
}));

import { authorizeLoopPublisher, LOOP_PUBLISH_CAPABILITY } from '../authorize-publisher';

const NODE_DID = 'did:imajin:node-witness';
const PRINCIPAL = 'did:imajin:ryan';
const PUBLISHER = 'did:imajin:some-agent';

beforeEach(() => {
  vi.clearAllMocks();
  mockGetNodeSigningIdentity.mockReturnValue({
    senderDid: NODE_DID,
    senderPubkey: 'B'.repeat(64),
    privateKeyHex: 'a'.repeat(64),
  });
});

describe('authorizeLoopPublisher', () => {
  it('authorizes self-publish (publisherDid === principal) without consulting grants', async () => {
    const result = await authorizeLoopPublisher(PRINCIPAL, PRINCIPAL);

    expect(result).toEqual({ authorized: true });
    expect(mockIntrospectGrant).not.toHaveBeenCalled();
  });

  it("authorizes the kernel node's own signing DID for any principal, with no grant required (#2338 path stays intact)", async () => {
    const result = await authorizeLoopPublisher(NODE_DID, PRINCIPAL);

    expect(result).toEqual({ authorized: true });
    expect(mockIntrospectGrant).not.toHaveBeenCalled();
  });

  it('authorizes a publisher holding an active, unexpired loops:publish grant from the principal', async () => {
    mockIntrospectGrant.mockResolvedValueOnce({ authorized: true, grantId: 'grant_1' });

    const result = await authorizeLoopPublisher(PUBLISHER, PRINCIPAL);

    expect(result).toEqual({ authorized: true });
    expect(mockIntrospectGrant).toHaveBeenCalledWith({
      agentDid: PUBLISHER,
      capability: LOOP_PUBLISH_CAPABILITY,
      delegatorDid: PRINCIPAL,
      targetDid: PRINCIPAL,
    });
  });

  it('denies a publisher whose grant has been revoked or expired', async () => {
    mockIntrospectGrant.mockResolvedValueOnce({
      authorized: false,
      reason: 'No active, unexpired grant covers this capability and audience',
    });

    const result = await authorizeLoopPublisher(PUBLISHER, PRINCIPAL);

    expect(result.authorized).toBe(false);
  });

  it('denies an unrelated publisher that holds no grant from this principal at all', async () => {
    mockIntrospectGrant.mockResolvedValueOnce({
      authorized: false,
      reason: 'No active, unexpired grant covers this capability and audience',
    });

    const result = await authorizeLoopPublisher('did:imajin:stranger', PRINCIPAL);

    expect(result.authorized).toBe(false);
    expect(mockIntrospectGrant).toHaveBeenCalledWith(
      expect.objectContaining({ agentDid: 'did:imajin:stranger', delegatorDid: PRINCIPAL }),
    );
  });

  it('propagates a storage error from introspectGrant rather than resolving authorized', async () => {
    mockIntrospectGrant.mockRejectedValueOnce(new Error('db unavailable'));

    await expect(authorizeLoopPublisher(PUBLISHER, PRINCIPAL)).rejects.toThrow('db unavailable');
  });
});
