/**
 * Tests for revokeAttestationOnce (#1795).
 *
 * The compare-and-swap UPDATE (id + revokedAt IS NULL) is the source of
 * truth for whether a caller "won" the revocation — everything downstream
 * (signing + inserting the `app.revoked` attestation, tearing down refresh
 * tokens) must only happen for the winner.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('nanoid', () => ({ nanoid: () => 'testid0000000000' }));

const mocks = vi.hoisted(() => {
  const updateSetMock = vi.fn();
  const updateWhereMock = vi.fn();
  const updateReturningMock = vi.fn();
  const updateMock = vi.fn(() => ({ set: updateSetMock }));

  const insertValuesMock = vi.fn().mockResolvedValue(undefined);
  const insertMock = vi.fn(() => ({ values: insertValuesMock }));

  const signSyncMock = vi.fn().mockReturnValue('sig');

  return {
    updateSetMock,
    updateWhereMock,
    updateReturningMock,
    updateMock,
    insertValuesMock,
    insertMock,
    signSyncMock,
  };
});

vi.mock('@/src/db', () => ({
  db: { update: mocks.updateMock, insert: mocks.insertMock },
  attestations: {
    id: 'attestations.id',
    subjectDid: 'attestations.subjectDid',
    revokedAt: 'attestations.revokedAt',
  },
  oauthRefreshTokens: {
    attestationId: 'oauthRefreshTokens.attestationId',
    revokedAt: 'oauthRefreshTokens.revokedAt',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: (...args: unknown[]) => ({ eq: args }),
  and: (...args: unknown[]) => ({ and: args }),
  isNull: (...args: unknown[]) => ({ isNull: args }),
}));

vi.mock('@imajin/auth', () => ({
  canonicalize: (v: unknown) => JSON.stringify(v),
  crypto: { signSync: mocks.signSyncMock },
}));

import { revokeAttestationOnce } from '../revoke-attestation';

const ATTESTATION_ID = 'att_test123';
const SUBJECT_DID = 'did:imajin:agrifortress';
const ISSUER_DID = 'did:imajin:user';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.signSyncMock.mockReturnValue('sig');
  mocks.insertValuesMock.mockResolvedValue(undefined);
  mocks.updateSetMock.mockImplementation(() => ({ where: mocks.updateWhereMock }));
  mocks.updateWhereMock.mockImplementation(() => ({ returning: mocks.updateReturningMock }));
});

describe('revokeAttestationOnce (#1795)', () => {
  it('claims the attestation, records app.revoked, and revokes the refresh-token chain', async () => {
    // Only the claim UPDATE chains a `.returning()` call; the follow-up
    // refresh-token revoke does not, so only one value needs queuing here.
    mocks.updateReturningMock.mockResolvedValueOnce([{ subjectDid: SUBJECT_DID }]);

    const result = await revokeAttestationOnce({
      attestationId: ATTESTATION_ID,
      revokedByDid: ISSUER_DID,
      privateKey: 'test-private-key',
    });

    expect(result).toEqual({ revoked: true, subjectDid: SUBJECT_DID });
    expect(mocks.insertValuesMock).toHaveBeenCalledOnce();
    const inserted = mocks.insertValuesMock.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.type).toBe('app.revoked');
    expect(inserted.subjectDid).toBe(SUBJECT_DID);
    expect((inserted.payload as { revokedAttestationId: string }).revokedAttestationId).toBe(ATTESTATION_ID);
    // Two updates: claiming the attestation, then revoking refresh tokens.
    expect(mocks.updateMock).toHaveBeenCalledTimes(2);
  });

  it('does not write an app.revoked record when the attestation was already revoked (lost the race)', async () => {
    mocks.updateReturningMock.mockResolvedValueOnce([]); // nothing matched revokedAt IS NULL

    const result = await revokeAttestationOnce({
      attestationId: ATTESTATION_ID,
      revokedByDid: ISSUER_DID,
      privateKey: 'test-private-key',
    });

    expect(result).toEqual({ revoked: false });
    expect(mocks.insertValuesMock).not.toHaveBeenCalled();
    // Only the (losing) claim attempt — no follow-up refresh-token revoke.
    expect(mocks.updateMock).toHaveBeenCalledTimes(1);
  });

  it('creates only one app.revoked record when called concurrently for the same attestation', async () => {
    // First caller wins the compare-and-swap; every subsequent caller loses.
    mocks.updateReturningMock
      .mockResolvedValueOnce([{ subjectDid: SUBJECT_DID }])
      .mockResolvedValue([]);

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        revokeAttestationOnce({
          attestationId: ATTESTATION_ID,
          revokedByDid: ISSUER_DID,
          privateKey: 'test-private-key',
        }),
      ),
    );

    expect(results.filter((r) => r.revoked)).toHaveLength(1);
    expect(mocks.insertValuesMock).toHaveBeenCalledOnce();
  });
});
