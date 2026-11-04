import { canonicalize } from '@imajin/auth';
import { getLoopOutputArtifact } from './artifact-store';
import type { LoopEventJson } from './serialize';
import { isSurfaceEventType, type LoopEnvelope } from './types';
import { loopObservationId } from './surface-lease';
import { verifyLoopPublisherSignature, type VerifyLoopPublisherSignatureResult } from './verify-publisher-signature';

/** Verify stored evidence, never infer a signature for historical unsigned rows. */
export async function verifyStoredLoopReceipt(event: LoopEventJson): Promise<VerifyLoopPublisherSignatureResult> {
  if (!event.signature || !event.publisherDid) return { ok: false, error: 'Unsigned historical receipt' };
  try {
    const payload = await signedPayload(event);
    if (!payload || !matchesReceipt(event, payload)) {
      return { ok: false, error: 'Stored receipt does not match signed facts' };
    }
    return await verifyLoopPublisherSignature(event.publisherDid, { type: event.type, payload }, event.signature);
  } catch {
    return { ok: false, error: 'Stored receipt evidence is unavailable or malformed' };
  }
}
function matchesReceipt(event: LoopEventJson, payload: LoopEnvelope): boolean {
  return event.issuer === event.publisherDid
    && event.loopId === payload.loopId && event.principal === payload.principal
    && (event.causeEventId ?? null) === (payload.causeEventId ?? null)
    && event.occurredAt === new Date(payload.at).toISOString()
    && event.id === loopObservationId({
      type: event.type, payload, publisherDid: event.publisherDid!, signature: event.signature!,
    });
}

async function signedPayload(event: LoopEventJson): Promise<LoopEnvelope | null> {
  const stored = { ...event.payload };
  const proof = stored.publisherProof as { payload?: LoopEnvelope } | undefined;
  delete stored.publisherProof;
  if (isSurfaceEventType(event.type)) {
    delete stored.evidence;
    delete stored.observedConflictingLoopId;
    delete stored.observedConflictingHolderDid;
  }
  const output = stored.output;
  if (output && 'artifactRef' in output) {
    const artifact = await getLoopOutputArtifact(event.loopId, event.principal, output.artifactRef.id);
    if (!artifact) return null;
    stored.output = artifact.output;
  }
  if (!proof) return stored as LoopEnvelope;
  if (!proof.payload) return null;
  const original = { ...proof.payload };
  delete original.publisherProof;
  // Server proof metadata must not mask a tampered history projection.
  if (canonicalize(original) !== canonicalize(stored)) return null;
  return proof.payload;
}
