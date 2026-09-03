import { db, attestations } from "@/src/db";
import { canonicalize, crypto as authCrypto } from "@imajin/auth";
import type { AttestationType } from "@imajin/auth";
import { computeCid } from "@imajin/cid";
import { getNodeDid } from "@/src/lib/kernel/node-identity";
import { createLogger } from '@imajin/logger';
import { randomUUID } from 'node:crypto';

const log = createLogger('kernel');

const ATTESTATION_TYPE: AttestationType = "session.device.new";

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

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
 * login itself, not an access gate. Mirrors `emitSessionAttestation`'s
 * shape and failure semantics exactly: mechanical, node-signed, and
 * non-fatal when the private key or node DID isn't configured.
 */
export async function emitDeviceAttestation(params: DeviceAttestationParams): Promise<void> {
  const privateKey = process.env.AUTH_PRIVATE_KEY;
  if (!privateKey) {
    log.warn({}, 'device attestation skipped: AUTH_PRIVATE_KEY not set');
    return;
  }

  const platformDid = await getNodeDid();
  if (!platformDid) {
    log.warn({}, 'device attestation skipped: node DID not set');
    return;
  }

  const issuedAtMs = Date.now();
  const payload = {
    device_id: params.deviceId,
    platform: params.platform,
    browser: params.browser,
    first_device: params.isFirstDevice,
  };

  const canonicalPayload = canonicalize({
    subject_did: params.did,
    type: ATTESTATION_TYPE,
    context_id: params.deviceId,
    context_type: "device",
    payload,
    issued_at: issuedAtMs,
  });

  try {
    const signature = authCrypto.signSync(canonicalPayload, privateKey);

    let cid: string | null = null;
    try {
      cid = await computeCid({
        issuerDid: platformDid,
        subjectDid: params.did,
        type: ATTESTATION_TYPE,
        contextId: params.deviceId,
        contextType: "device",
        payload,
        issuedAt: issuedAtMs,
      });
    } catch { /* non-fatal */ }

    await db.insert(attestations).values({
      id: genId("att"),
      issuerDid: platformDid,
      subjectDid: params.did,
      type: ATTESTATION_TYPE,
      contextId: params.deviceId,
      contextType: "device",
      payload,
      signature,
      cid,
      // Mechanical audit record, never bilateral — same reasoning as
      // session.created (#1822): null it out explicitly so it never shows
      // up as "pending your countersignature" anywhere.
      attestationStatus: null,
      issuedAt: new Date(issuedAtMs),
    });
  } catch (err) {
    log.error({ err: String(err) }, 'device attestation error');
  }
}
