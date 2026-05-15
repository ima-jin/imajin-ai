import { NextRequest, NextResponse } from 'next/server';
import { db, attestations, attestationSignatures, identities, assets } from '@/src/db';
import { eq, and, inArray } from 'drizzle-orm';
import { corsHeaders } from '@imajin/config';
import { requireAuth } from '@/src/lib/auth/middleware';
import { publish } from '@imajin/bus';
import { createLogger } from '@imajin/logger';
import * as jose from 'jose';

const log = createLogger('kernel:documents');

function genId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 14)}${Date.now().toString(36)}`;
}

const EXPIRY_MAP: Record<string, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '1m': 30 * 24 * 60 * 60 * 1000,
  '1y': 365 * 24 * 60 * 60 * 1000,
};

async function verifyJws(jws: string, publicKeyHex: string): Promise<boolean> {
  try {
    const publicKeyBytes = Buffer.from(publicKeyHex, 'hex');
    const jwk = {
      kty: 'OKP',
      crv: 'Ed25519',
      x: jose.base64url.encode(publicKeyBytes),
    };
    const publicKey = await jose.importJWK(jwk, 'EdDSA');
    await jose.compactVerify(jws, publicKey);
    return true;
  } catch {
    return false;
  }
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

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: cors });
  }

  const {
    title,
    document_asset_id,
    document_hash,
    signers,
    payload,
    author_jws,
  } = body as {
    title?: string;
    document_asset_id?: string;
    document_hash?: string;
    signers?: string[];
    payload?: Record<string, unknown>;
    author_jws?: string;
  };

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

    // Validate inputs
    if (!title || typeof title !== 'string') {
      return NextResponse.json({ error: 'title required' }, { status: 400, headers: cors });
    }
    if (!document_asset_id || typeof document_asset_id !== 'string') {
      return NextResponse.json({ error: 'document_asset_id required' }, { status: 400, headers: cors });
    }
    if (!document_hash || typeof document_hash !== 'string') {
      return NextResponse.json({ error: 'document_hash required' }, { status: 400, headers: cors });
    }
    if (!Array.isArray(signers) || signers.length === 0) {
      return NextResponse.json({ error: 'signers array required (at least 1)' }, { status: 400, headers: cors });
    }
    if (!author_jws || typeof author_jws !== 'string') {
      return NextResponse.json({ error: 'author_jws required' }, { status: 400, headers: cors });
    }

    const signerDids = signers.filter((s): s is string => typeof s === 'string' && s.startsWith('did:'));
    if (signerDids.length !== signers.length) {
      return NextResponse.json({ error: 'All signers must be valid DIDs' }, { status: 400, headers: cors });
    }

    // Verify caller owns the new document asset
    const [asset] = await db
      .select()
      .from(assets)
      .where(eq(assets.id, document_asset_id))
      .limit(1);

    if (!asset) {
      return NextResponse.json({ error: 'Document asset not found' }, { status: 404, headers: cors });
    }
    if (asset.ownerDid !== callerDid) {
      return NextResponse.json({ error: 'You do not own this document' }, { status: 403, headers: cors });
    }
    if (asset.hash !== document_hash) {
      return NextResponse.json({ error: 'Document hash mismatch' }, { status: 400, headers: cors });
    }

    // Verify author JWS
    const [callerIdentity] = await db
      .select({ publicKey: identities.publicKey })
      .from(identities)
      .where(eq(identities.id, callerDid))
      .limit(1);

    if (!callerIdentity) {
      return NextResponse.json({ error: 'Caller identity not found' }, { status: 400, headers: cors });
    }

    const jwsValid = await verifyJws(author_jws, callerIdentity.publicKey);
    if (!jwsValid) {
      return NextResponse.json({ error: 'Invalid author JWS signature' }, { status: 400, headers: cors });
    }

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
        authorJws: author_jws,
        attestationStatus: 'collecting',
        documentHash: document_hash,
        documentAssetId: document_asset_id,
        totalSigners: 1 + signerDids.length,
        issuedAt: new Date(),
      })
      .returning();

    // Create signature rows
    const now = new Date();
    const sigRows = [
      {
        id: genId('sig'),
        attestationId,
        signerDid: callerDid,
        jws: author_jws,
        signedAt: now,
        status: 'signed',
        role: 'creator',
      },
      ...signerDids.map((did) => ({
        id: genId('sig'),
        attestationId,
        signerDid: did,
        jws: null as string | null,
        signedAt: null as Date | null,
        status: 'pending' as string,
        role: 'signer' as string,
      })),
    ];

    await db.insert(attestationSignatures).values(sigRows);

    // Set asset immutable
    await db.update(assets).set({ immutable: true }).where(eq(assets.id, document_asset_id));

    // Publish event
    publish('document.created', {
      issuer: callerDid,
      subject: callerDid,
      scope: 'auth',
      payload: {
        attestationId,
        documentAssetId: document_asset_id,
        creatorDid: callerDid,
        signerDids,
        context_id: attestationId,
        context_type: 'document',
      },
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
