import { NextRequest, NextResponse } from 'next/server';
import { db, attestations, attestationSignatures, identities, assets, folders, assetFolders } from '@/src/db';
import { eq, and, sql } from 'drizzle-orm';
import { corsHeaders } from '@imajin/config';
import { requireAuth } from '@/src/lib/auth/middleware';
import { publish } from '@imajin/bus';
import { createLogger } from '@imajin/logger';
import { mkdir, copyFile } from 'node:fs/promises';
import { nanoid } from 'nanoid';
import path from 'node:path';
import { verifyDocumentSignatureToken } from '@/src/lib/auth/document-signatures';
import { randomUUID } from 'node:crypto';

const log = createLogger('kernel:documents');

const MEDIA_ROOT = process.env.MEDIA_ROOT || '/mnt/media';

function didToPath(did: string): string {
  return did.replace(/:/g, '_').replace(/[^a-zA-Z0-9._@-]/g, '_');
}

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}


/**
 * Copy a signed document to the signer's media storage.
 */
async function copyDocumentToSigner(
  originalAsset: typeof assets.$inferSelect,
  signerDid: string,
  documentId: string
): Promise<string | null> {
  try {
    const signerPath = didToPath(signerDid);
    const signedDir = `${MEDIA_ROOT}/${signerPath}/.signed`;
    await mkdir(signedDir, { recursive: true });

    const originalExt = path.extname(originalAsset.storagePath);
    const newAssetId = `asset_${nanoid(16)}`;
    const newStoragePath = `${signedDir}/${newAssetId}${originalExt}`;

    await copyFile(originalAsset.storagePath, newStoragePath);

    // Find or create "Signed Documents" folder
    let folderId: string | null = null;
    const [existingFolder] = await db
      .select()
      .from(folders)
      .where(
        and(
          eq(folders.ownerDid, signerDid),
          eq(folders.name, 'Signed Documents'),
          eq(folders.isSystem, true)
        )
      )
      .limit(1);

    if (existingFolder) {
      folderId = existingFolder.id;
    } else {
      const newFolderId = `folder_${nanoid(16)}`;
      const [inserted] = await db
        .insert(folders)
        .values({
          id: newFolderId,
          ownerDid: signerDid,
          name: 'Signed Documents',
          icon: '📝',
          isSystem: true,
        })
        .onConflictDoNothing()
        .returning();
      folderId = inserted?.id ?? newFolderId;
      // Race: if onConflictDoNothing, fetch the existing one
      if (!inserted) {
        const [retry] = await db
          .select()
          .from(folders)
          .where(
            and(
              eq(folders.ownerDid, signerDid),
              eq(folders.name, 'Signed Documents'),
              eq(folders.isSystem, true)
            )
          )
          .limit(1);
        if (retry) folderId = retry.id;
      }
    }

    // Insert asset record
    const [newAsset] = await db
      .insert(assets)
      .values({
        id: newAssetId,
        ownerDid: signerDid,
        filename: originalAsset.filename,
        mimeType: originalAsset.mimeType,
        size: originalAsset.size,
        storagePath: newStoragePath,
        hash: originalAsset.hash,
        immutable: true,
        folderId,
        metadata: {
          signed: true,
          originalAssetId: originalAsset.id,
          documentId,
          signedAt: new Date().toISOString(),
        },
        status: 'active',
      })
      .returning();

    // Link to folder
    if (folderId) {
      await db.insert(assetFolders).values({ assetId: newAssetId, folderId }).onConflictDoNothing();
    }

    return newAssetId;
  } catch (err) {
    log.error({ err: String(err), signerDid, documentId }, 'Copy document to signer failed');
    return null;
  }
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * POST /api/documents/[id]/sign — Sign a document
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

  let body: { jws?: string; document_hash?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: cors });
  }

  const { jws, document_hash } = body;
  if (!jws || typeof jws !== 'string') {
    return NextResponse.json({ error: 'jws required' }, { status: 400, headers: cors });
  }
  if (!document_hash || typeof document_hash !== 'string') {
    return NextResponse.json({ error: 'document_hash required' }, { status: 400, headers: cors });
  }

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

    if (attestation.attestationStatus === 'declined') {
      return NextResponse.json({ error: 'Document has been declined' }, { status: 409, headers: cors });
    }
    if (attestation.attestationStatus === 'executed') {
      return NextResponse.json({ error: 'Document is already executed' }, { status: 409, headers: cors });
    }
    if (attestation.attestationStatus !== 'collecting') {
      return NextResponse.json({ error: `Cannot sign — document is ${attestation.attestationStatus}` }, { status: 409, headers: cors });
    }

    // Check expiry
    if (attestation.expiresAt && new Date() > attestation.expiresAt) {
      await db.update(attestations).set({ attestationStatus: 'expired' }).where(eq(attestations.id, id));
      return NextResponse.json({ error: 'Document has expired' }, { status: 410, headers: cors });
    }

    // Verify document hash
    if (attestation.documentHash !== document_hash) {
      return NextResponse.json({ error: 'Document hash mismatch' }, { status: 400, headers: cors });
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

    // Verify JWS signature
    const [callerIdentity] = await db
      .select({ publicKey: identities.publicKey })
      .from(identities)
      .where(eq(identities.id, callerDid))
      .limit(1);

    if (!callerIdentity) {
      return NextResponse.json({ error: 'Signer identity not found' }, { status: 400, headers: cors });
    }

    const signatureValid = await verifyDocumentSignatureToken({
      token: jws,
      signerPublicKeyHex: callerIdentity.publicKey,
      signerDid: callerDid,
      documentHash: document_hash,
    });
    if (!signatureValid) {
      return NextResponse.json({ error: 'Invalid JWS signature' }, { status: 400, headers: cors });
    }

    // Update signature row
    await db
      .update(attestationSignatures)
      .set({ status: 'signed', jws, signedAt: new Date() })
      .where(eq(attestationSignatures.id, sigRow.id));

    // Check if all signed
    const [pendingCount] = await db
      .select({ count: sql<number>`count(*)` })
      .from(attestationSignatures)
      .where(
        and(
          eq(attestationSignatures.attestationId, id),
          eq(attestationSignatures.status, 'pending')
        )
      );

    const allSigned = pendingCount.count === 0;

    if (allSigned) {
      await db
        .update(attestations)
        .set({ attestationStatus: 'executed' })
        .where(eq(attestations.id, id));

      // Copy document to signer
      if (attestation.documentAssetId) {
        const [asset] = await db
          .select()
          .from(assets)
          .where(eq(assets.id, attestation.documentAssetId))
          .limit(1);
        if (asset) {
          await copyDocumentToSigner(asset, callerDid, id);
        }
      }

      // Publish executed
      publish('document.executed', {
        issuer: callerDid,
        subject: attestation.issuerDid,
        scope: 'auth',
        payload: {
          attestationId: id,
          documentAssetId: attestation.documentAssetId ?? '',
          creatorDid: attestation.issuerDid,
          signerDids: [], // filled below
          context_id: id,
          context_type: 'document',
        },
      });

      return NextResponse.json({ status: 'executed', id }, { headers: cors });
    }

    // Copy document to signer even for partial sign
    if (attestation.documentAssetId) {
      const [asset] = await db
        .select()
        .from(assets)
        .where(eq(assets.id, attestation.documentAssetId))
        .limit(1);
      if (asset) {
        await copyDocumentToSigner(asset, callerDid, id);
      }
    }

    // Publish signed
    publish('document.signed', {
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

    return NextResponse.json({ status: 'signed', id }, { headers: cors });
  } catch (error) {
    log.error({ err: String(error), documentId: id }, 'Document sign error');
    return NextResponse.json({ error: 'Failed to sign document' }, { status: 500, headers: cors });
  }
}
