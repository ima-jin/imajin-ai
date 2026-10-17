/**
 * Tests for emitMechanicalAttestation — the shared node-signed attestation
 * primitive behind emitSessionAttestation (#1822) and emitDeviceAttestation
 * (#306).
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

import { emitMechanicalAttestation, prepareMechanicalAttestation } from '../emit-mechanical-attestation';

const PLATFORM_DID = 'did:imajin:6Y6fwZeqe1wME3heZ2vy1cV3x9zwq4Gphqm6yKC95dBg';
const SUBJECT_DID = 'did:imajin:veteze';

const BASE_PARAMS = {
  subjectDid: SUBJECT_DID,
  type: 'session.created' as const,
  contextId: null,
  contextType: 'auth',
  payload: { method: 'keypair' },
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AUTH_PRIVATE_KEY = 'test-private-key';
  mocks.getNodeDidMock.mockResolvedValue(PLATFORM_DID);
  mocks.signSyncMock.mockReturnValue('sig');
  mocks.computeCidMock.mockResolvedValue('bafy-test');
  mocks.insertValuesMock.mockResolvedValue(undefined);
});

describe('emitMechanicalAttestation', () => {
  it('prepares a deterministic signed row without inserting, using the existing canonical signature shape', async () => {
    const row = await prepareMechanicalAttestation(BASE_PARAMS, 'att_reach_reach_test');
    expect(row).toMatchObject({
      id: 'att_reach_reach_test', issuerDid: PLATFORM_DID, subjectDid: SUBJECT_DID,
      signature: 'sig', cid: 'bafy-test', attestationStatus: null,
    });
    expect(mocks.insertValuesMock).not.toHaveBeenCalled();
    expect(mocks.signSyncMock).toHaveBeenCalledWith(JSON.stringify({
      subject_did: SUBJECT_DID, type: BASE_PARAMS.type, context_id: null, context_type: 'auth',
      payload: BASE_PARAMS.payload, issued_at: row.issuedAt.getTime(),
    }), 'test-private-key');
  });

  it('throws when preparation has no signing key', async () => {
    delete process.env.AUTH_PRIVATE_KEY;
    await expect(prepareMechanicalAttestation(BASE_PARAMS)).rejects.toThrow('AUTH_PRIVATE_KEY');
    expect(mocks.insertValuesMock).not.toHaveBeenCalled();
  });

  it('throws when preparation has no node DID', async () => {
    mocks.getNodeDidMock.mockResolvedValue(null);
    await expect(prepareMechanicalAttestation(BASE_PARAMS)).rejects.toThrow('node DID');
  });

  it('throws on prepare signing failure while emit remains nonfatal', async () => {
    mocks.signSyncMock.mockImplementation(() => { throw new Error('signing failed'); });
    await expect(prepareMechanicalAttestation(BASE_PARAMS)).rejects.toThrow('signing failed');
    await expect(emitMechanicalAttestation(BASE_PARAMS)).resolves.toBeNull();
  });
  it('inserts an attestation with attestationStatus explicitly null', async () => {
    await emitMechanicalAttestation(BASE_PARAMS);

    expect(mocks.insertValuesMock).toHaveBeenCalledOnce();
    const inserted = mocks.insertValuesMock.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.type).toBe('session.created');
    expect(inserted.subjectDid).toBe(SUBJECT_DID);
    expect(inserted.issuerDid).toBe(PLATFORM_DID);
    expect(inserted.contextId).toBeNull();
    expect(inserted.contextType).toBe('auth');
    expect(inserted.payload).toEqual({ method: 'keypair' });
    expect(inserted.attestationStatus).toBeNull();
    expect(inserted.signature).toBe('sig');
    expect(inserted.cid).toBe('bafy-test');
  });

  it('passes contextId/contextType through for a device-scoped attestation', async () => {
    await emitMechanicalAttestation({
      subjectDid: SUBJECT_DID,
      type: 'session.device.new',
      contextId: 'dev_abc123',
      contextType: 'device',
      payload: { device_id: 'dev_abc123', first_device: true },
    });

    const inserted = mocks.insertValuesMock.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.type).toBe('session.device.new');
    expect(inserted.contextId).toBe('dev_abc123');
    expect(inserted.contextType).toBe('device');
    expect(inserted.payload).toEqual({ device_id: 'dev_abc123', first_device: true });
  });

  it('does not write anything when AUTH_PRIVATE_KEY is unset', async () => {
    delete process.env.AUTH_PRIVATE_KEY;

    await emitMechanicalAttestation(BASE_PARAMS);

    expect(mocks.insertValuesMock).not.toHaveBeenCalled();
  });

  it('does not write anything when the node DID is unset', async () => {
    mocks.getNodeDidMock.mockResolvedValue(null);

    await emitMechanicalAttestation(BASE_PARAMS);

    expect(mocks.insertValuesMock).not.toHaveBeenCalled();
  });

  it('still inserts with a null cid when computeCid rejects (non-fatal)', async () => {
    mocks.computeCidMock.mockRejectedValueOnce(new Error('cid down'));

    await emitMechanicalAttestation(BASE_PARAMS);

    const inserted = mocks.insertValuesMock.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.cid).toBeNull();
  });

  it('does not throw when the DB insert rejects', async () => {
    mocks.insertValuesMock.mockRejectedValueOnce(new Error('db down'));

    await expect(emitMechanicalAttestation(BASE_PARAMS)).resolves.toBeNull();
  });

  it('returns the written attestation id on success', async () => {
    const id = await emitMechanicalAttestation(BASE_PARAMS);
    expect(id).toMatch(/^att_/);
  });

  it('returns null when AUTH_PRIVATE_KEY is unset', async () => {
    delete process.env.AUTH_PRIVATE_KEY;
    await expect(emitMechanicalAttestation(BASE_PARAMS)).resolves.toBeNull();
  });
});
