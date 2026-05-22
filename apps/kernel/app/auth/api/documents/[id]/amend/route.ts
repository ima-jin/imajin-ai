import { NextRequest, NextResponse } from 'next/server';
import { db, attestations, attestationSignatures, assets } from '@/src/db';
import { eq, and } from 'drizzle-orm';
import { corsHeaders } from '@imajin/config';
import { requireAuth } from '@/src/lib/auth/middleware';
import { createLogger } from '@imajin/logger';
import {
  buildDocumentSignatureRows,
  getCreatorDisplayName,
  parseDocumentRequestBody,
  publishDocumentCreatedNotifications,
  validateDocumentRequestInput,
} from '../../../../../../src/lib/auth/document-attestation';

const log = createLogger('kernel:documents');

function genId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 14)}${Date.now().toString(36)}`;
}


export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
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

  const session = await requireAuth(request);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: cors });
  }

  const callerDid = session.sub;
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

    if (!original) {
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
    const [attestation] = await db
      .insert(attestations)
      .values({
        id: attestationId,
        issuerDid: callerDid,
        subjectDid: callerDid,
        type: 'document.amended',
        payload: {
          title,
          amends: original.cid ?? original.id,
          ...(payload ?? {}),
        },
        signature: '',
        authorJws,
        attestationStatus: 'collecting',
        documentHash,
        documentAssetId: documentAssetId,
        totalSigners: 1 + signerDids.length,
        issuedAt: new Date(),
      })
      .returning();

    // Create signature rows
    const sigRows = buildDocumentSignatureRows({
      attestationId,
      creatorDid: callerDid,
      creatorJws: authorJws,
      signerDids,
      genId,
    });

    await db.insert(attestationSignatures).values(sigRows);

    // Set asset immutable
    await db.update(assets).set({ immutable: true }).where(eq(assets.id, documentAssetId));

    // Publish one event per pending signer so notify reactors can target recipients directly.
    const creatorName = getCreatorDisplayName(callerIdentity, callerDid);
    publishDocumentCreatedNotifications({
      attestationId,
      documentAssetId,
      creatorDid: callerDid,
      creatorName,
      signerDids,
      title,
      log,
    });

    const allSigs = await db
      .select()
      .from(attestationSignatures)
      .where(eq(attestationSignatures.attestationId, attestationId));

    return NextResponse.json(
      { attestation, signatures: allSigs },
      { status: 201, headers: cors }
    );
  } catch (error) {
    log.error({ err: String(error), originalId }, 'Document amend error');
    return NextResponse.json({ error: 'Failed to amend document' }, { status: 500, headers: cors });
  }
}
