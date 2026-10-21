import { NextRequest, NextResponse } from 'next/server';
import { db, attestations, attestationSignatures } from '@/src/db';
import { eq, and } from 'drizzle-orm';
import { corsHeaders } from '@imajin/config';
import { requireDocumentActor } from '@/src/lib/auth/document-authorization';
import { isDocumentType } from '@/src/lib/auth/document-types';
import { createLogger } from '@imajin/logger';
import {
  finalizeDocumentAttestation,
  buildDocumentPayload,
  getCreatorDisplayName,
  publishDocumentCreatedNotifications,
  parseDocumentRequestBody,
  validateDocumentRequestInput,
} from '../../../../../../src/lib/auth/document-attestation';
import { randomUUID } from 'node:crypto';

const log = createLogger('kernel:documents');
export const dynamic = 'force-dynamic';

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

/**
 * POST /api/documents/[id]/amend — Create an amendment
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const cors = corsHeaders(request);
  const { id: originalId } = await params;

  const actor = await requireDocumentActor(request, { write: true });
  if (actor instanceof Response) return actor;
  const callerDid = actor.effectiveDid;
  const parseResult = await parseDocumentRequestBody(request);
  if (!parseResult.ok) {
    return NextResponse.json({ error: parseResult.failure.error }, { status: parseResult.failure.status, headers: cors });
  }

  try {
    // Load original attestation
    const [original] = await db
      .select()
      .from(attestations)
      .where(eq(attestations.id, originalId))
      .limit(1);

    if (!original?.documentHash || !isDocumentType(original.type)) {
      return NextResponse.json({ error: 'Original document not found' }, { status: 404, headers: cors });
    }

    // Verify caller is creator or a signer of the original
    const isCreator = original.issuerDid === callerDid;
    const [callerSig] = await db
      .select()
      .from(attestationSignatures)
      .where(
        and(
          eq(attestationSignatures.attestationId, originalId),
          eq(attestationSignatures.signerDid, callerDid)
        )
      )
      .limit(1);

    if (!isCreator && !callerSig) {
      return NextResponse.json({ error: 'Only the creator or a signer can amend' }, { status: 403, headers: cors });
    }
    const validationResult = await validateDocumentRequestInput({ body: parseResult.body, callerDid });
    if (!validationResult.ok) {
      return NextResponse.json({ error: validationResult.failure.error }, { status: validationResult.failure.status, headers: cors });
    }
    const {
      title,
      documentAssetId,
      documentHash,
      signerDids,
      payload,
      authorJws,
      callerIdentity,
    } = validationResult.input;

    // Create amendment attestation
    const attestationId = genId('att');
    const { attestation, allSigs } = await db.transaction(async (tx) => {
      const [attestation] = await tx.insert(attestations).values({
        id: attestationId, issuerDid: callerDid,
        subjectDid: signerDids.length === 1 ? signerDids[0] : callerDid,
        type: 'document.amended',
        payload: buildDocumentPayload({
          payload, title, documentHash, creatorDid: callerDid, actingHumanDid: actor.actingHumanDid,
          signerDids, authorJws, issuerScope: callerIdentity.scope,
          amends: original.cid ?? original.id,
        }),
        signature: '', authorJws, attestationStatus: 'collecting',
        documentHash, documentAssetId, totalSigners: 1 + signerDids.length, issuedAt: new Date(),
      }).returning();
      const allSigs = await finalizeDocumentAttestation({
        attestationId, documentAssetId, creatorDid: callerDid, creatorJws: authorJws,
        signerDids, title, callerIdentity, genId, log,
        store: tx, notify: false, documentHash,
      });
      return { attestation, allSigs };
    });
    publishDocumentCreatedNotifications({
      attestationId, documentAssetId, creatorDid: callerDid,
      creatorName: getCreatorDisplayName(callerIdentity, callerDid), signerDids, title, log,
    });

    return NextResponse.json(
      { attestation, signatures: allSigs },
      { status: 201, headers: cors }
    );
  } catch (error) {
    log.error({ err: String(error), originalId }, 'Document amend error');
    return NextResponse.json({ error: 'Failed to amend document' }, { status: 500, headers: cors });
  }
}

export { preflight as OPTIONS } from '@/app/auth/lib/preflight';
