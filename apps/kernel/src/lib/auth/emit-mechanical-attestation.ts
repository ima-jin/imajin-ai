/**
 * Shared "mint a mechanical (node-signed) attestation" primitive.
 *
 * `emitSessionAttestation` (#1822, `session.created`) and
 * `emitDeviceAttestation` (#306, `session.device.new`) both mint a signed
 * attestation the same way — sign with `AUTH_PRIVATE_KEY`, resolve the
 * node's own DID, canonicalize + CID the payload, insert the row with
 * `attestationStatus` explicitly nulled out (mechanical audit records are
 * never bilateral, so they must never surface as "pending your
 * countersignature") — differing only in type/context/payload. Factored
 * out once rather than repeated per emitter.
 */
import { db, attestations } from "@/src/db";
import { canonicalize, crypto as authCrypto } from "@imajin/auth";
import type { AttestationType } from "@imajin/auth";
import { computeCid } from "@imajin/cid";
import { getNodeDid } from "@/src/lib/kernel/node-identity";
import { createLogger } from '@imajin/logger';
import { randomUUID } from 'node:crypto';

const log = createLogger('kernel');

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

export interface MechanicalAttestationParams {
  subjectDid: string;
  type: AttestationType;
  contextId: string | null;
  contextType: string | null;
  payload: Record<string, unknown>;
}

/**
 * Non-fatal by design: a missing `AUTH_PRIVATE_KEY`/node DID, a signing
 * error, or a DB failure all just skip/log rather than throw — mechanical
 * attestations are proof-of-history, never a gate the caller must react to.
 */
export async function emitMechanicalAttestation(params: MechanicalAttestationParams): Promise<void> {
  const privateKey = process.env.AUTH_PRIVATE_KEY;
  if (!privateKey) {
    log.warn({ type: params.type }, 'mechanical attestation skipped: AUTH_PRIVATE_KEY not set');
    return;
  }

  const platformDid = await getNodeDid();
  if (!platformDid) {
    log.warn({ type: params.type }, 'mechanical attestation skipped: node DID not set');
    return;
  }

  const issuedAtMs = Date.now();
  const canonicalPayload = canonicalize({
    subject_did: params.subjectDid,
    type: params.type,
    context_id: params.contextId,
    context_type: params.contextType,
    payload: params.payload,
    issued_at: issuedAtMs,
  });

  try {
    const signature = authCrypto.signSync(canonicalPayload, privateKey);

    let cid: string | null = null;
    try {
      cid = await computeCid({
        issuerDid: platformDid,
        subjectDid: params.subjectDid,
        type: params.type,
        contextId: params.contextId,
        contextType: params.contextType,
        payload: params.payload,
        issuedAt: issuedAtMs,
      });
    } catch { /* non-fatal */ }

    await db.insert(attestations).values({
      id: genId("att"),
      issuerDid: platformDid,
      subjectDid: params.subjectDid,
      type: params.type,
      contextId: params.contextId,
      contextType: params.contextType,
      payload: params.payload,
      signature,
      cid,
      attestationStatus: null,
      issuedAt: new Date(issuedAtMs),
    });
  } catch (err) {
    log.error({ err: String(err), type: params.type }, 'mechanical attestation error');
  }
}
