import { db, attestations, systemEvents } from '@/src/db';
import { getNodeSelfInfo } from '@/src/lib/kernel/node-identity';
import { prepareMechanicalAttestation } from '@/src/lib/auth/emit-mechanical-attestation';
import { OPS_LIVENESS_ACTION, type LivenessEvent } from './ops-liveness-contract';

/** Acknowledged only after both records commit. Re-delivery is idempotent. */
export async function recordLivenessEvent(event: LivenessEvent): Promise<void> {
  const node = await getNodeSelfInfo();
  if (!node?.nodeOperatorDid) throw new Error('Node operator is not configured');
  const payload = { ...event, operatorDid: node.nodeOperatorDid, issuerDid: node.did };
  const attestation = await prepareMechanicalAttestation({
    subjectDid: node.nodeOperatorDid, type: OPS_LIVENESS_ACTION,
    contextId: event.app, contextType: 'ops', payload,
  }, `att_ops_${event.id}`);
  await db.transaction(async (tx) => {
    await tx.insert(attestations).values(attestation).onConflictDoNothing();
    await tx.insert(systemEvents).values({
      id: `ops_${event.id}`, service: 'ops', action: OPS_LIVENESS_ACTION,
      did: attestation.issuerDid, correlationId: event.id,
      payload: { ...payload, attestationId: attestation.id },
      status: event.outcome === 'restart-failed' ? 'failure' : 'success',
    }).onConflictDoNothing();
  });
}
