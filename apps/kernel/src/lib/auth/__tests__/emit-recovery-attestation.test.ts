/**
 * Tests for emitRecoveryCodesGeneratedAttestation / emitRecoveryRedeemedAttestation
 * (#1250 Phase 1). Both are mechanical audit records minted by the kernel
 * node identity, mirroring `emitSessionAttestation` (#1822) — never an
 * `author_jws`, never awaiting a countersignature.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
  const insertValuesMock = vi.fn().mockResolvedValue(undefined);
  const insertMock = vi.fn(() => ({ values: insertValuesMock }));
  const signSyncMock = vi.fn().mockReturnValue('sig');
  const getNodeDidMock = vi.fn();
  const computeCidMock = vi.fn().mockResolvedValue('bafy-test');

  return { insertValuesMock, insertMock, signSyncMock, getNodeDidMock, computeCidMock };
});

vi.mock('@/src/db', () => ({
  db: { insert: mocks.insertMock },
  attestations: {},
}));

vi.mock('@imajin/auth', () => ({
  canonicalize: (v: unknown) => JSON.stringify(v),
  crypto: { signSync: mocks.signSyncMock },
}));

vi.mock('@imajin/cid', () => ({ computeCid: mocks.computeCidMock }));

vi.mock('@/src/lib/kernel/node-identity', () => ({
  getNodeDid: mocks.getNodeDidMock,
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

import { emitRecoveryCodesGeneratedAttestation, emitRecoveryRedeemedAttestation } from '../emit-recovery-attestation';

const PLATFORM_DID = 'did:imajin:6Y6fwZeqe1wME3heZ2vy1cV3x9zwq4Gphqm6yKC95dBg';
const SUBJECT_DID = 'did:imajin:recoverable';

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AUTH_PRIVATE_KEY = 'test-private-key';
  mocks.getNodeDidMock.mockResolvedValue(PLATFORM_DID);
  mocks.signSyncMock.mockReturnValue('sig');
  mocks.computeCidMock.mockResolvedValue('bafy-test');
  mocks.insertValuesMock.mockResolvedValue(undefined);
});

describe('emitRecoveryCodesGeneratedAttestation', () => {
  it('inserts a recovery.codes.generated attestation carrying only the count', async () => {
    await emitRecoveryCodesGeneratedAttestation({ did: SUBJECT_DID, count: 10 });

    expect(mocks.insertValuesMock).toHaveBeenCalledOnce();
    const inserted = mocks.insertValuesMock.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.type).toBe('recovery.codes.generated');
    expect(inserted.subjectDid).toBe(SUBJECT_DID);
    expect(inserted.issuerDid).toBe(PLATFORM_DID);
    expect(inserted.payload).toEqual({ count: 10 });
    expect(inserted.attestationStatus).toBeNull();
  });

  it('does not write anything when AUTH_PRIVATE_KEY is unset', async () => {
    delete process.env.AUTH_PRIVATE_KEY;

    await emitRecoveryCodesGeneratedAttestation({ did: SUBJECT_DID, count: 10 });

    expect(mocks.insertValuesMock).not.toHaveBeenCalled();
  });

  it('does not write anything when the node DID is unset', async () => {
    mocks.getNodeDidMock.mockResolvedValue('');

    await emitRecoveryCodesGeneratedAttestation({ did: SUBJECT_DID, count: 10 });

    expect(mocks.insertValuesMock).not.toHaveBeenCalled();
  });

  it('does not throw when the db insert fails (fire-and-forget, non-fatal)', async () => {
    mocks.insertValuesMock.mockRejectedValueOnce(new Error('db down'));

    await expect(emitRecoveryCodesGeneratedAttestation({ did: SUBJECT_DID, count: 10 })).resolves.toBeUndefined();
  });
});

describe('emitRecoveryRedeemedAttestation', () => {
  it('inserts a recovery.redeemed attestation with an empty payload', async () => {
    await emitRecoveryRedeemedAttestation({ did: SUBJECT_DID });

    expect(mocks.insertValuesMock).toHaveBeenCalledOnce();
    const inserted = mocks.insertValuesMock.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.type).toBe('recovery.redeemed');
    expect(inserted.subjectDid).toBe(SUBJECT_DID);
    expect(inserted.payload).toEqual({});
    expect(inserted.attestationStatus).toBeNull();
  });

  it('does not write anything when AUTH_PRIVATE_KEY is unset', async () => {
    delete process.env.AUTH_PRIVATE_KEY;

    await emitRecoveryRedeemedAttestation({ did: SUBJECT_DID });

    expect(mocks.insertValuesMock).not.toHaveBeenCalled();
  });

  it('does not write anything when the node DID is unset', async () => {
    mocks.getNodeDidMock.mockResolvedValue('');

    await emitRecoveryRedeemedAttestation({ did: SUBJECT_DID });

    expect(mocks.insertValuesMock).not.toHaveBeenCalled();
  });

  it('tolerates a CID computation failure and still writes the attestation', async () => {
    mocks.computeCidMock.mockRejectedValueOnce(new Error('cid service unavailable'));

    await emitRecoveryRedeemedAttestation({ did: SUBJECT_DID });

    expect(mocks.insertValuesMock).toHaveBeenCalledOnce();
    const inserted = mocks.insertValuesMock.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.cid).toBeNull();
  });
});
