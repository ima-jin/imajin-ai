import type { AttestationType } from "@imajin/auth";
import { emitMechanicalAttestation } from "./emit-mechanical-attestation";

const ATTESTATION_TYPE: AttestationType = "session.device.new";

export interface DeviceAttestationParams {
  did: string;
  deviceId: string;
  platform: string;
  browser: string;
  isFirstDevice: boolean;
}

/**
 * Emit a signed `session.device.new` attestation (#306) recording that a
 * device fingerprint was recorded for this DID — proof-of-history for the
 * login itself, not an access gate. Delegates the signing/insert mechanics
 * to `emitMechanicalAttestation`, shared with `emitSessionAttestation`
 * (#1822).
 */
export async function emitDeviceAttestation(params: DeviceAttestationParams): Promise<void> {
  await emitMechanicalAttestation({
    subjectDid: params.did,
    type: ATTESTATION_TYPE,
    contextId: params.deviceId,
    contextType: "device",
    payload: {
      device_id: params.deviceId,
      platform: params.platform,
      browser: params.browser,
      first_device: params.isFirstDevice,
    },
  });
}
