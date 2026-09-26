import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockGetNodeDid, mockEmitMechanicalAttestation, mockDb } = vi.hoisted(() => {
  const limitFn = vi.fn();
  const whereSelectFn = vi.fn(() => ({ limit: limitFn }));
  const fromFn = vi.fn(() => ({ where: whereSelectFn }));
  const selectFn = vi.fn(() => ({ from: fromFn }));

  const returningFn = vi.fn();
  const whereUpdateFn = vi.fn(() => ({ returning: returningFn }));
  const setFn = vi.fn(() => ({ where: whereUpdateFn }));
  const updateFn = vi.fn(() => ({ set: setFn }));

  return {
    mockGetNodeDid: vi.fn(),
    mockEmitMechanicalAttestation: vi.fn(),
    mockDb: { selectFn, fromFn, whereSelectFn, limitFn, updateFn, setFn, whereUpdateFn, returningFn },
  };
});

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq: (...args: unknown[]) => ({ eq: args }),
  gt: (...args: unknown[]) => ({ gt: args }),
  isNull: (...args: unknown[]) => ({ isNull: args }),
  or: (...args: unknown[]) => ({ or: args }),
}));

vi.mock('@/src/db', () => ({
  db: { select: mockDb.selectFn, update: mockDb.updateFn },
  attestations: {
    id: 'id',
    subjectDid: 'subject_did',
    issuerDid: 'issuer_did',
    type: 'type',
    revokedAt: 'revoked_at',
    expiresAt: 'expires_at',
  },
}));

vi.mock('@/src/lib/kernel/node-identity', () => ({
  getNodeDid: mockGetNodeDid,
}));

vi.mock('@/src/lib/auth/emit-mechanical-attestation', () => ({
  emitMechanicalAttestation: mockEmitMechanicalAttestation,
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

import {
  isRelayPeerAttested,
  admitRelayPeer,
  revokeRelayPeer,
  resetRelayPeerAttestationCacheForTests,
  RELAY_PEER_ATTESTATION_TYPE,
  RELAY_PEER_ATTESTATION_CACHE_TTL_MS,
} from '../peer-attestations';

const NODE_DID = 'did:imajin:node-self';
const PEER_DID = 'did:dfos:peer-abc';

beforeEach(() => {
  vi.clearAllMocks();
  resetRelayPeerAttestationCacheForTests();
  mockGetNodeDid.mockResolvedValue(NODE_DID);
  mockDb.limitFn.mockResolvedValue([]);
  mockDb.returningFn.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('RELAY_PEER_ATTESTATION_TYPE', () => {
  it('is the registered attestation type name', () => {
    expect(RELAY_PEER_ATTESTATION_TYPE).toBe('relay.peer');
  });
});

describe('isRelayPeerAttested', () => {
  it('returns true when a live attestation row exists', async () => {
    mockDb.limitFn.mockResolvedValue([{ id: 'att_1' }]);

    expect(await isRelayPeerAttested(PEER_DID)).toBe(true);
    expect(mockDb.selectFn).toHaveBeenCalledTimes(1);
  });

  it('returns false when no attestation row exists', async () => {
    mockDb.limitFn.mockResolvedValue([]);

    expect(await isRelayPeerAttested(PEER_DID)).toBe(false);
  });

  it('returns false without querying the DB when the node has no resolvable DID', async () => {
    mockGetNodeDid.mockResolvedValue('');

    expect(await isRelayPeerAttested(PEER_DID)).toBe(false);
    expect(mockDb.selectFn).not.toHaveBeenCalled();
  });

  it('caches a positive result for the TTL window, avoiding a second DB hit', async () => {
    vi.useFakeTimers();
    mockDb.limitFn.mockResolvedValue([{ id: 'att_1' }]);

    expect(await isRelayPeerAttested(PEER_DID)).toBe(true);
    vi.advanceTimersByTime(RELAY_PEER_ATTESTATION_CACHE_TTL_MS - 1);
    expect(await isRelayPeerAttested(PEER_DID)).toBe(true);

    expect(mockDb.selectFn).toHaveBeenCalledTimes(1);
  });

  it('re-queries once the cache TTL has elapsed — revocation takes effect within the TTL', async () => {
    vi.useFakeTimers();
    mockDb.limitFn.mockResolvedValue([{ id: 'att_1' }]);
    expect(await isRelayPeerAttested(PEER_DID)).toBe(true);

    // Simulate a revoke landing in the DB, then let the cache expire.
    mockDb.limitFn.mockResolvedValue([]);
    vi.advanceTimersByTime(RELAY_PEER_ATTESTATION_CACHE_TTL_MS + 1);

    expect(await isRelayPeerAttested(PEER_DID)).toBe(false);
    expect(mockDb.selectFn).toHaveBeenCalledTimes(2);
  });
});

describe('admitRelayPeer', () => {
  it('mints a relay.peer attestation for the DID and invalidates its cache entry', async () => {
    mockEmitMechanicalAttestation.mockResolvedValue('att_new');
    // Prime a cached "not attested" result, which admit must invalidate.
    mockDb.limitFn.mockResolvedValue([]);
    await isRelayPeerAttested(PEER_DID);

    const result = await admitRelayPeer(PEER_DID);

    expect(result).toEqual({ ok: true, attestationId: 'att_new' });
    expect(mockEmitMechanicalAttestation).toHaveBeenCalledWith(
      expect.objectContaining({ subjectDid: PEER_DID, type: RELAY_PEER_ATTESTATION_TYPE }),
    );

    // Cache was invalidated — the next check re-queries rather than reusing the stale "false".
    mockDb.limitFn.mockResolvedValue([{ id: 'att_new' }]);
    expect(await isRelayPeerAttested(PEER_DID)).toBe(true);
  });

  it('reports failure when the attestation could not be minted', async () => {
    mockEmitMechanicalAttestation.mockResolvedValue(null);

    const result = await admitRelayPeer(PEER_DID);

    expect(result).toEqual({ ok: false, error: 'attestation_mint_failed' });
  });
});

describe('revokeRelayPeer', () => {
  it('revokes every live relay.peer attestation for the DID and invalidates its cache entry', async () => {
    mockDb.limitFn.mockResolvedValue([{ id: 'att_1' }]);
    expect(await isRelayPeerAttested(PEER_DID)).toBe(true);

    mockDb.returningFn.mockResolvedValue([{ id: 'att_1' }]);
    const result = await revokeRelayPeer(PEER_DID);

    expect(result).toEqual({ ok: true, revokedCount: 1 });
    expect(mockDb.updateFn).toHaveBeenCalledTimes(1);

    // Cache was invalidated — the next check re-queries rather than reusing the stale "true".
    mockDb.limitFn.mockResolvedValue([]);
    expect(await isRelayPeerAttested(PEER_DID)).toBe(false);
  });

  it('reports zero revocations when nothing was live', async () => {
    mockDb.returningFn.mockResolvedValue([]);

    const result = await revokeRelayPeer(PEER_DID);

    expect(result).toEqual({ ok: true, revokedCount: 0 });
  });

  it('fails without touching the DB when the node has no resolvable DID', async () => {
    mockGetNodeDid.mockResolvedValue('');

    const result = await revokeRelayPeer(PEER_DID);

    expect(result).toEqual({ ok: false, revokedCount: 0, error: 'node_did_unresolved' });
    expect(mockDb.updateFn).not.toHaveBeenCalled();
  });
});
