/**
 * Tests for emitDeviceAttestation (#306).
 *
 * `session.device.new` is a mechanical audit record minted by the kernel
 * node identity whenever logDevice() records a device fingerprint it has
 * not seen before for a DID — mirrors emitSessionAttestation's (#1822)
 * shape and non-fatal failure semantics exactly.
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

import { emitDeviceAttestation } from '../emit-device-attestation';

const PLATFORM_DID = 'did:imajin:6Y6fwZeqe1wME3heZ2vy1cV3x9zwq4Gphqm6yKC95dBg';
const SUBJECT_DID = 'did:imajin:veteze';

const BASE_PARAMS = {
  did: SUBJECT_DID,
  deviceId: 'dev_abc123',
  platform: 'macOS',
  browser: 'Chrome',
  isFirstDevice: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AUTH_PRIVATE_KEY = 'test-private-key';
  mocks.getNodeDidMock.mockResolvedValue(PLATFORM_DID);
  mocks.signSyncMock.mockReturnValue('sig');
  mocks.computeCidMock.mockResolvedValue('bafy-test');
  mocks.insertValuesMock.mockResolvedValue(undefined);
});

describe('emitDeviceAttestation (#306)', () => {
  it('inserts session.device.new with attestationStatus explicitly null', async () => {
    await emitDeviceAttestation(BASE_PARAMS);

    expect(mocks.insertValuesMock).toHaveBeenCalledOnce();
    const inserted = mocks.insertValuesMock.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.type).toBe('session.device.new');
    expect(inserted.subjectDid).toBe(SUBJECT_DID);
    expect(inserted.contextId).toBe('dev_abc123');
    expect(inserted.contextType).toBe('device');
    expect(inserted.attestationStatus).toBeNull();
    expect(inserted.payload).toMatchObject({
      device_id: 'dev_abc123',
      platform: 'macOS',
      browser: 'Chrome',
      first_device: false,
    });
  });

  it('records first_device: true for the DID\'s first device', async () => {
    await emitDeviceAttestation({ ...BASE_PARAMS, isFirstDevice: true });

    const inserted = mocks.insertValuesMock.mock.calls[0][0] as Record<string, unknown>;
    expect((inserted.payload as Record<string, unknown>).first_device).toBe(true);
  });

  it('does not write anything when AUTH_PRIVATE_KEY is unset', async () => {
    delete process.env.AUTH_PRIVATE_KEY;

    await emitDeviceAttestation(BASE_PARAMS);

    expect(mocks.insertValuesMock).not.toHaveBeenCalled();
  });

  it('does not write anything when the node DID is unset', async () => {
    mocks.getNodeDidMock.mockResolvedValue(null);

    await emitDeviceAttestation(BASE_PARAMS);

    expect(mocks.insertValuesMock).not.toHaveBeenCalled();
  });

  it('does not throw when the DB insert rejects', async () => {
    mocks.insertValuesMock.mockRejectedValueOnce(new Error('db down'));

    await expect(emitDeviceAttestation(BASE_PARAMS)).resolves.toBeUndefined();
  });
});
