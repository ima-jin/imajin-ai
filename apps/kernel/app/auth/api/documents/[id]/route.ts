import { NextRequest, NextResponse } from 'next/server';
import { db, attestations, attestationSignatures, identities, assets } from '@/src/db';
import { eq, inArray, and, sql } from 'drizzle-orm';
import { corsHeaders } from '@imajin/config';
import { requireDocumentActor, canReadDocument } from '@/src/lib/auth/document-authorization';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel:documents');
export const dynamic = 'force-dynamic';

/**
 * GET /api/documents/[id] — Get document with all signatures
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const cors = corsHeaders(request);
  const { id } = await params;

  const actor = await requireDocumentActor(request);
  if (actor instanceof Response) return actor;

  try {
    // Load attestation
    const [attestation] = await db
      .select()
      .from(attestations)
      .where(eq(attestations.id, id))
      .limit(1);

    if (!attestation || !attestation.documentHash) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404, headers: cors });
    }

    // Verify caller is creator or signer
    if (!await canReadDocument(id, attestation.issuerDid, actor)) {
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
    // Prefer this party's copy. Org readers use the issuer-owned copy; never
    // expose a different party's private asset as the downloadable reference.
    const copyOwner = signatures.some((sig) => sig.signerDid === actor.effectiveDid)
      ? actor.effectiveDid : attestation.issuerDid;
    const [copy] = await db.select({ id: assets.id }).from(assets).where(and(
      eq(assets.ownerDid, copyOwner),
      sql`${assets.metadata}->>'documentId' = ${id}`,
      eq(assets.status, 'active'),
    )).limit(1);

    return NextResponse.json(
      { attestation: { ...attestation, documentAssetId: copy?.id ?? attestation.documentAssetId }, signatures: signaturesWithIdentity },
      { headers: cors }
    );
  } catch (error) {
    log.error({ err: String(error), documentId: id }, 'Document GET error');
    return NextResponse.json({ error: 'Failed to load document' }, { status: 500, headers: cors });
  }
}

export { preflight as OPTIONS } from '@/app/auth/lib/preflight';
