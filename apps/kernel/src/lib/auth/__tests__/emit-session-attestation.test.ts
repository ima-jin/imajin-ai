/**
 * Tests for emitSessionAttestation (#1822).
 *
 * `session.created` is a mechanical audit record minted by the kernel node
 * identity on every session start — it never carries an `author_jws` and is
 * never awaiting a countersignature. The `attestations.attestation_status`
 * column defaults to 'pending' at the schema level, so the insert here must
 * explicitly null it out; otherwise every session start silently surfaces as
 * "pending your countersignature" in any view/query built on that column.
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

import { emitSessionAttestation } from '../emit-session-attestation';

const PLATFORM_DID = 'did:imajin:6Y6fwZeqe1wME3heZ2vy1cV3x9zwq4Gphqm6yKC95dBg';
const SUBJECT_DID = 'did:imajin:veteze';

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AUTH_PRIVATE_KEY = 'test-private-key';
  mocks.getNodeDidMock.mockResolvedValue(PLATFORM_DID);
  mocks.signSyncMock.mockReturnValue('sig');
  mocks.computeCidMock.mockResolvedValue('bafy-test');
  mocks.insertValuesMock.mockResolvedValue(undefined);
});

describe('emitSessionAttestation (#1822)', () => {
  it('inserts session.created with attestationStatus explicitly null', async () => {
    await emitSessionAttestation({ did: SUBJECT_DID, method: 'keypair', tier: 'established' });

    expect(mocks.insertValuesMock).toHaveBeenCalledOnce();
    const inserted = mocks.insertValuesMock.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.type).toBe('session.created');
    expect(inserted.subjectDid).toBe(SUBJECT_DID);
    expect(inserted.attestationStatus).toBeNull();
  });

  it('does not write anything when AUTH_PRIVATE_KEY is unset', async () => {
    delete process.env.AUTH_PRIVATE_KEY;

    await emitSessionAttestation({ did: SUBJECT_DID, method: 'keypair', tier: 'established' });

    expect(mocks.insertValuesMock).not.toHaveBeenCalled();
  });

  it('does not write anything when the node DID is unset', async () => {
    mocks.getNodeDidMock.mockResolvedValue(null);

    await emitSessionAttestation({ did: SUBJECT_DID, method: 'keypair', tier: 'established' });

    expect(mocks.insertValuesMock).not.toHaveBeenCalled();
  });
});
