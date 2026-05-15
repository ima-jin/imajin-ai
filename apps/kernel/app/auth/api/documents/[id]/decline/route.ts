import { NextRequest, NextResponse } from 'next/server';
import { db, attestations, attestationSignatures } from '@/src/db';
import { eq, and } from 'drizzle-orm';
import { corsHeaders } from '@imajin/config';
import { requireAuth } from '@/src/lib/auth/middleware';
import { publish } from '@imajin/bus';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel:documents');

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * POST /api/documents/[id]/decline — Decline a document
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const cors = corsHeaders(request);
  const { id } = await params;

  const session = await requireAuth(request);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: cors });
  }

  const callerDid = session.sub;

  try {
    // Load attestation
    const [attestation] = await db
      .select()
      .from(attestations)
      .where(eq(attestations.id, id))
      .limit(1);

    if (!attestation) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404, headers: cors });
    }

    if (attestation.attestationStatus === 'executed') {
      return NextResponse.json({ error: 'Document is already executed' }, { status: 409, headers: cors });
    }
    if (attestation.attestationStatus === 'declined') {
      return NextResponse.json({ error: 'Document is already declined' }, { status: 409, headers: cors });
    }
    if (attestation.attestationStatus !== 'collecting') {
      return NextResponse.json({ error: `Cannot decline — document is ${attestation.attestationStatus}` }, { status: 409, headers: cors });
    }

    // Find caller's pending signature row
    const [sigRow] = await db
      .select()
      .from(attestationSignatures)
      .where(
        and(
          eq(attestationSignatures.attestationId, id),
          eq(attestationSignatures.signerDid, callerDid),
          eq(attestationSignatures.status, 'pending')
        )
      )
      .limit(1);

    if (!sigRow) {
      return NextResponse.json({ error: 'You are not a pending signer for this document' }, { status: 403, headers: cors });
    }

    // Update signature row to declined
    await db
      .update(attestationSignatures)
      .set({ status: 'declined' })
      .where(eq(attestationSignatures.id, sigRow.id));

    // Update attestation to declined
    await db
      .update(attestations)
      .set({ attestationStatus: 'declined' })
      .where(eq(attestations.id, id));

    // Publish declined
    publish('document.declined', {
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
    });

    return NextResponse.json({ status: 'declined', id }, { headers: cors });
  } catch (error) {
    log.error({ err: String(error), documentId: id }, 'Document decline error');
    return NextResponse.json({ error: 'Failed to decline document' }, { status: 500, headers: cors });
  }
}
