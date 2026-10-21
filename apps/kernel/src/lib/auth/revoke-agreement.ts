import { and, eq, isNull } from 'drizzle-orm';
import { db, attestations, attestationSignatures } from '@/src/db';
import { prepareMechanicalAttestation } from './emit-mechanical-attestation';

/** The tombstone and its signed event commit together, exactly once. */
export function revokeAgreement(params: {
  attestationId: string;
  effectiveDid: string;
  actingHumanDid: string;
}): Promise<{ status: number; error?: string; id?: string; revokedAt?: Date }> {
  const privateKey = process.env.AUTH_PRIVATE_KEY;
  if (!privateKey) return Promise.resolve({ status: 503, error: 'Agreement revocation signing unavailable' });
  return db.transaction(async (tx) => {
    const [agreement] = await tx.select().from(attestations)
      .where(eq(attestations.id, params.attestationId)).limit(1).for('update');
    if (agreement?.type !== 'agreement') return { status: 404, error: 'Agreement not found' };
    const signatures = await tx.select().from(attestationSignatures)
      .where(eq(attestationSignatures.attestationId, agreement.id));
    const isParty = agreement.issuerDid === params.effectiveDid
      || signatures.some((signature) => signature.signerDid === params.effectiveDid && signature.status === 'signed');
    if (!isParty) return { status: 403, error: 'Only an agreement party can revoke' };
    if (agreement.revokedAt) return { status: 409, error: 'Attestation is already revoked' };
    const revokedAt = new Date();
    const payload = {
      agreementId: agreement.id,
      documentHash: agreement.documentHash,
      orgDid: agreement.issuerDid,
      revokedByDid: params.effectiveDid,
      actingHumanDid: params.actingHumanDid,
      revokedAt: revokedAt.toISOString(),
      signatureKind: 'node-witness',
    };
    const event = await prepareMechanicalAttestation({
      subjectDid: agreement.issuerDid,
      type: 'agreement.revoked',
      contextId: agreement.id,
      contextType: 'attestation',
      payload,
    });
    await tx.update(attestations).set({ revokedAt, attestationStatus: 'revoked' })
      .where(and(eq(attestations.id, agreement.id), isNull(attestations.revokedAt)));
    await tx.insert(attestations).values(event);
    return { status: 200, id: agreement.id, revokedAt };
  });
}
