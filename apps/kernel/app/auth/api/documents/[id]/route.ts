import { NextRequest, NextResponse } from 'next/server';
import { db, attestations, attestationSignatures, identities } from '@/src/db';
import { eq, and, inArray } from 'drizzle-orm';
import { corsHeaders } from '@imajin/config';
import { requireAuth } from '@/src/lib/auth/middleware';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel:documents');

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * GET /api/documents/[id] — Get document with all signatures
 */
export async function GET(
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

    // Verify caller is creator or signer
    const isCreator = attestation.issuerDid === callerDid;
    const callerSig = await db
      .select()
      .from(attestationSignatures)
      .where(
        and(
          eq(attestationSignatures.attestationId, id),
          eq(attestationSignatures.signerDid, callerDid)
        )
      )
      .limit(1);

    if (!isCreator && callerSig.length === 0) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403, headers: cors });
    }

    // Load all signatures
    const signatures = await db
      .select()
      .from(attestationSignatures)
      .where(eq(attestationSignatures.attestationId, id))
      .orderBy(attestationSignatures.createdAt);

    // Resolve identity info for all signers
    const signerDids = [...new Set(signatures.map((s) => s.signerDid))];
    const identityMap = new Map<string, { handle: string | null; name: string | null; avatarUrl: string | null }>();
    if (signerDids.length > 0) {
      const identityRows = await db
        .select({ id: identities.id, handle: identities.handle, name: identities.name, avatarUrl: identities.avatarUrl })
        .from(identities)
        .where(inArray(identities.id, signerDids));
      for (const row of identityRows) {
        identityMap.set(row.id, row);
      }
    }

    const signaturesWithIdentity = signatures.map((sig) => ({
      ...sig,
      identity: identityMap.get(sig.signerDid) ?? null,
    }));

    return NextResponse.json(
      { attestation, signatures: signaturesWithIdentity },
      { headers: cors }
    );
  } catch (error) {
    log.error({ err: String(error), documentId: id }, 'Document GET error');
    return NextResponse.json({ error: 'Failed to load document' }, { status: 500, headers: cors });
  }
}
