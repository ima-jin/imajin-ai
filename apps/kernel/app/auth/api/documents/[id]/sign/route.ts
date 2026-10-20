import { NextRequest, NextResponse } from 'next/server';
import { db, attestations, attestationSignatures, identities, assets } from '@/src/db';
import { eq, and } from 'drizzle-orm';
import { corsHeaders } from '@imajin/config';
import { requireDocumentActor } from '@/src/lib/auth/document-authorization';
import { publish } from '@imajin/bus';
import { createLogger } from '@imajin/logger';
import { verifyDocumentSignatureToken } from '@/src/lib/auth/document-signatures';
import { copyDocumentToSigner } from '@/src/lib/auth/document-copies';
import { completedDocumentType } from '@/src/lib/auth/document-types';

const log = createLogger('kernel:documents');
export const dynamic = 'force-dynamic';

/** Serialize every signature transition under the document lock. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const cors = corsHeaders(request);
  const { id } = await params;
  const actor = await requireDocumentActor(request, { write: true });
  if (actor instanceof Response) return actor;
  let body: { jws?: unknown; document_hash?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: cors });
  }
  if (!body || typeof body.jws !== 'string' || !body.jws) {
    return NextResponse.json({ error: 'jws required' }, { status: 400, headers: cors });
  }
  if (typeof body.document_hash !== 'string' || !body.document_hash) {
    return NextResponse.json({ error: 'document_hash required' }, { status: 400, headers: cors });
  }
  const jws = body.jws;
  const documentHash = body.document_hash;
  try {
    const result = await db.transaction(async (tx) => {
      const [attestation] = await tx.select().from(attestations)
        .where(eq(attestations.id, id)).limit(1).for('update');
      const failure = validateDocumentForSigning(attestation, documentHash);
      if (failure) return failure;
      if (!attestation) return { error: 'Document not found', status: 404 };
      const signatures = await tx.select().from(attestationSignatures)
        .where(eq(attestationSignatures.attestationId, id));
      const ownRows = signatures.filter((signature) => signature.signerDid === actor.effectiveDid);
      if (ownRows.length !== 1 || ownRows[0].status !== 'pending') {
        return { error: 'You are not a pending signer for this document', status: 403 };
      }
      const [identity] = await tx.select({ publicKey: identities.publicKey }).from(identities)
        .where(eq(identities.id, actor.effectiveDid)).limit(1);
      if (!identity || !await verifyDocumentSignatureToken({
        token: jws, signerPublicKeyHex: identity.publicKey,
        signerDid: actor.effectiveDid, documentHash,
      })) return { error: 'Invalid JWS signature', status: 400 };

      // No write happens before signer, hash and signed-payload validation.
      if (attestation.documentAssetId) {
        const [asset] = await tx.select().from(assets)
          .where(eq(assets.id, attestation.documentAssetId)).limit(1);
        if (!asset) return { error: 'Document asset not found', status: 404 };
        if (asset.hash !== documentHash) return { error: 'Document asset hash mismatch', status: 400 };
        await copyDocumentToSigner(asset, actor.effectiveDid, id, { store: tx, required: true });
      }
      await tx.update(attestationSignatures).set({ status: 'signed', jws, signedAt: new Date() })
        .where(and(eq(attestationSignatures.id, ownRows[0].id), eq(attestationSignatures.status, 'pending')));
      const allSigned = signatures.length === new Set(signatures.map((row) => row.signerDid)).size
        && signatures.length === attestation.totalSigners
        && signatures.every((row) => row.signerDid === actor.effectiveDid || row.status === 'signed');
      const payload = (attestation.payload ?? {}) as Record<string, unknown>;
      const signedBy = (payload.signedBy ?? {}) as Record<string, unknown>;
      const [issuer] = allSigned
        ? await tx.select({ scope: identities.scope }).from(identities)
          .where(eq(identities.id, attestation.issuerDid)).limit(1)
        : [];
      await tx.update(attestations).set({
        ...(allSigned ? { type: completedDocumentType(attestation.type, issuer?.scope), attestationStatus: 'executed' } : {}),
        payload: {
          ...payload,
          signedBy: { ...signedBy, [actor.effectiveDid]: {
            actingHumanDid: actor.actingHumanDid,
            signatureModel: jws.split('.').length === 3 ? 'did-key' : 'node-witness',
          } },
        },
      }).where(eq(attestations.id, id));
      return { attestation, allSigned, signerDids: signatures.map((row) => row.signerDid) };
    });
    if ('error' in result) {
      return NextResponse.json({ error: result.error }, { status: result.status, headers: cors });
    }
    const event = result.allSigned ? 'document.executed' : 'document.signed';
    await publish(event, {
      issuer: actor.effectiveDid, subject: result.attestation.issuerDid, scope: 'auth',
      payload: { attestationId: id, signerDid: actor.effectiveDid,
        documentAssetId: result.attestation.documentAssetId ?? '',
        creatorDid: result.attestation.issuerDid, signerDids: result.signerDids,
        context_id: id, context_type: 'document' },
    }).catch((error) => log.error({ err: String(error), documentId: id }, 'Document event failed'));
    return NextResponse.json({ status: result.allSigned ? 'executed' : 'signed', id }, { headers: cors });
  } catch (error) {
    log.error({ err: String(error), documentId: id }, 'Document sign error');
    return NextResponse.json({ error: 'Failed to sign document' }, { status: 500, headers: cors });
  }
}

function validateDocumentForSigning(
  attestation: typeof attestations.$inferSelect | undefined,
  documentHash: string,
): { error: string; status: number } | null {
  if (!attestation?.documentHash) return { error: 'Document not found', status: 404 };
  if (attestation.revokedAt) return { error: 'Document is revoked', status: 409 };
  if (attestation.attestationStatus !== 'collecting') {
    return { error: `Cannot sign — document is ${attestation.attestationStatus}`, status: 409 };
  }
  if (attestation.expiresAt && new Date() > attestation.expiresAt) {
    return { error: 'Document has expired', status: 410 };
  }
  if (attestation.documentHash !== documentHash) return { error: 'Document hash mismatch', status: 400 };
  const payload = (attestation.payload ?? {}) as Record<string, unknown>;
  if (payload.documentHash !== undefined && payload.documentHash !== documentHash) {
    return { error: 'Document payload hash mismatch', status: 400 };
  }
  return null;
}

export { preflight as OPTIONS } from '@/app/auth/lib/preflight';
