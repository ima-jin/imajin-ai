/**
 * Tests for emitDeviceAttestation (#306).
 *
 * The actual signing/insert mechanics now live in the shared
 * `emitMechanicalAttestation` primitive (see
 * emit-mechanical-attestation.test.ts for that coverage, including the
 * missing-key / missing-node-DID / non-fatal-failure cases) — this only
 * verifies emitDeviceAttestation calls it with the right
 * `session.device.new` shape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ emitMechanicalAttestation: vi.fn().mockResolvedValue(undefined) }));

vi.mock('../emit-mechanical-attestation', () => ({
  emitMechanicalAttestation: mocks.emitMechanicalAttestation,
}));

import { emitDeviceAttestation } from '../emit-device-attestation';

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
});

describe('emitDeviceAttestation (#306)', () => {
  it('delegates to emitMechanicalAttestation with the session.device.new shape', async () => {
    await emitDeviceAttestation(BASE_PARAMS);

    expect(mocks.emitMechanicalAttestation).toHaveBeenCalledWith({
      subjectDid: SUBJECT_DID,
      type: 'session.device.new',
      contextId: 'dev_abc123',
      contextType: 'device',
      payload: { device_id: 'dev_abc123', platform: 'macOS', browser: 'Chrome', first_device: false },
    });
  });

  it('passes isFirstDevice through as payload.first_device', async () => {
    await emitDeviceAttestation({ ...BASE_PARAMS, isFirstDevice: true });

    const call = mocks.emitMechanicalAttestation.mock.calls[0][0];
    expect(call.payload.first_device).toBe(true);
  });
});
