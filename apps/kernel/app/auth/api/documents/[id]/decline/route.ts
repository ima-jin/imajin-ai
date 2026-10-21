import { NextRequest, NextResponse } from 'next/server';
import { db, attestations, attestationSignatures } from '@/src/db';
import { eq, and } from 'drizzle-orm';
import { corsHeaders } from '@imajin/config';
import { requireDocumentActor } from '@/src/lib/auth/document-authorization';
import { isDocumentType } from '@/src/lib/auth/document-types';
import { publish } from '@imajin/bus';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel:documents');
export const dynamic = 'force-dynamic';

/**
 * POST /api/documents/[id]/decline — Decline a document
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const cors = corsHeaders(request);
  const { id } = await params;

  const actor = await requireDocumentActor(request, { write: true });
  if (actor instanceof Response) return actor;
  const callerDid = actor.effectiveDid;

  try {
    const result = await db.transaction(async (tx) => {
      const [attestation] = await tx.select().from(attestations)
        .where(eq(attestations.id, id)).limit(1).for('update');
      if (!attestation?.documentHash || !isDocumentType(attestation.type)) {
        return { error: 'Document not found', status: 404 };
      }
      if (attestation.revokedAt || attestation.attestationStatus !== 'collecting') {
        return { error: 'Document is not collecting signatures', status: 409 };
      }
      if (attestation.expiresAt && attestation.expiresAt <= new Date()) {
        return { error: 'Document has expired', status: 410 };
      }
      const [sigRow] = await tx.select().from(attestationSignatures)
        .where(and(
          eq(attestationSignatures.attestationId, id),
          eq(attestationSignatures.signerDid, callerDid),
          eq(attestationSignatures.status, 'pending'),
        )).limit(1);
      if (!sigRow) return { error: 'You are not a pending signer for this document', status: 403 };
      await tx.update(attestationSignatures).set({ status: 'declined' })
        .where(eq(attestationSignatures.id, sigRow.id));
      await tx.update(attestations).set({
        attestationStatus: 'declined',
        payload: {
          ...(attestation.payload as Record<string, unknown> | null),
          declinedBy: { did: callerDid, actingHumanDid: actor.actingHumanDid },
        },
      }).where(eq(attestations.id, id));
      return { attestation };
    });
    if ('error' in result) {
      return NextResponse.json({ error: result.error }, { status: result.status, headers: cors });
    }
    const { attestation } = result;

    // Publish declined
    await publish('document.declined', {
      issuer: callerDid,
      subject: attestation.issuerDid,
      scope: 'auth',
      payload: {
        attestationId: id,
        signerDid: callerDid,
        documentAssetId: attestation.documentAssetId ?? '',
        context_id: id,
        context_type: 'document',
      },
    }).catch((error) => log.error({ err: String(error), documentId: id }, 'Document decline event failed'));

    return NextResponse.json({ status: 'declined', id }, { headers: cors });
  } catch (error) {
    log.error({ err: String(error), documentId: id }, 'Document decline error');
    return NextResponse.json({ error: 'Failed to decline document' }, { status: 500, headers: cors });
  }
}

export { preflight as OPTIONS } from '@/app/auth/lib/preflight';
