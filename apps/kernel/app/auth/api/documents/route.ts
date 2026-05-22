import { NextRequest, NextResponse } from 'next/server';
import { db, attestations, attestationSignatures, identities, assets } from '@/src/db';
import { eq, and, or, isNull, desc, sql, inArray } from 'drizzle-orm';
import { corsHeaders } from '@imajin/config';
import { requireAuth } from '@/src/lib/auth/middleware';
import { ATTESTATION_TYPES } from '@imajin/auth';
import { publish } from '@imajin/bus';
import { createLogger } from '@imajin/logger';
import { verifyDocumentSignatureToken } from '@/src/lib/auth/document-signatures';

const log = createLogger('kernel:documents');

const DOCUMENT_LIMIT_MAX = 100;

function genId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 14)}${Date.now().toString(36)}`;
}

const EXPIRY_MAP: Record<string, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '1m': 30 * 24 * 60 * 60 * 1000,
  '1y': 365 * 24 * 60 * 60 * 1000,
};

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}


// ---------------------------------------------------------------------------
// POST /api/documents — Create a document signing request
// ---------------------------------------------------------------------------
export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

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
    expiry,
    author_jws,
  } = body as {
    title?: string;
    document_asset_id?: string;
    document_hash?: string;
    signers?: string[];
    payload?: Record<string, unknown>;
    expiry?: '24h' | '7d' | '1m' | '1y' | 'never';
    author_jws?: string;
  };

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

  // Verify all signer DIDs exist
  const signerDids = signers.filter((s): s is string => typeof s === 'string' && s.startsWith('did:'));
  if (signerDids.length !== signers.length) {
    return NextResponse.json({ error: 'All signers must be valid DIDs' }, { status: 400, headers: cors });
  }

  // Verify caller owns the document asset
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

  // Verify document hash matches stored asset
  if (asset.hash !== document_hash) {
    return NextResponse.json({ error: 'Document hash mismatch' }, { status: 400, headers: cors });
  }

  // Verify author JWS
  const [callerIdentity] = await db
    .select({ publicKey: identities.publicKey, name: identities.name, handle: identities.handle })
    .from(identities)
    .where(eq(identities.id, callerDid))
    .limit(1);

  if (!callerIdentity) {
    return NextResponse.json({ error: 'Caller identity not found' }, { status: 400, headers: cors });
  }

  const signatureValid = await verifyDocumentSignatureToken({
    token: author_jws,
    signerPublicKeyHex: callerIdentity.publicKey,
    signerDid: callerDid,
    documentHash: document_hash,
  });
  if (!signatureValid) {
    return NextResponse.json({ error: 'Invalid author JWS signature' }, { status: 400, headers: cors });
  }

  // Compute expiry
  const expiresAt = expiry === 'never' || !expiry
    ? null
    : new Date(Date.now() + (EXPIRY_MAP[expiry] ?? EXPIRY_MAP['7d']));

  const attestationId = genId('att');

  // Create attestation
  const [attestation] = await db
    .insert(attestations)
    .values({
      id: attestationId,
      issuerDid: callerDid,
      subjectDid: callerDid, // document is "about" the creator's action
      type: 'document.created',
      payload: {
        title,
        ...(payload ?? {}),
      },
      signature: '', // legacy — not used for document attestations
      authorJws: author_jws,
      attestationStatus: 'collecting',
      documentHash: document_hash,
      documentAssetId: document_asset_id,
      totalSigners: 1 + signerDids.length,
      issuedAt: new Date(),
      expiresAt,
    })
    .returning();

  // Create signature rows
  const now = new Date();
  const sigRows: { id: string; attestationId: string; signerDid: string; jws: string | null; signedAt: Date | null; status: string; role: string }[] = [
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
      jws: null,
      signedAt: null,
      status: 'pending' as string,
      role: 'signer' as string,
    })),
  ];

  await db.insert(attestationSignatures).values(sigRows);

  // Set asset immutable
  await db.update(assets).set({ immutable: true }).where(eq(assets.id, document_asset_id));

  // Publish one event per pending signer so notify reactors can target recipients directly.
  const creatorName = callerIdentity.handle
    ? `@${callerIdentity.handle}`
    : callerIdentity.name || callerDid;
  const signUrl = `/auth/documents/${attestationId}`;

  for (const signerDid of signerDids) {
    publish('document.created', {
      issuer: callerDid,
      subject: signerDid,
      scope: 'auth',
      payload: {
        attestationId,
        documentAssetId: document_asset_id,
        creatorDid: callerDid,
        creatorName,
        signerDids,
        title: title.trim(),
        signUrl,
        context_id: attestationId,
        context_type: 'document',
      },
    }).catch((err) => log.error({ err: String(err), signerDid, attestationId }, 'document.created publish failed'));
  }

  // Fetch signatures to return
  const allSigs = await db
    .select()
    .from(attestationSignatures)
    .where(eq(attestationSignatures.attestationId, attestationId));

  return NextResponse.json(
    { attestation, signatures: allSigs },
    { status: 201, headers: cors }
  );
}

// ---------------------------------------------------------------------------
// GET /api/documents — List documents for caller
// ---------------------------------------------------------------------------
export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);

  const session = await requireAuth(request);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: cors });
  }

  const callerDid = session.sub;
  const { searchParams } = new URL(request.url);

  const roleFilter = searchParams.get('role'); // 'creator' | 'signer' | 'all'
  const statusFilter = searchParams.get('status'); // 'collecting' | 'executed' | 'declined' | 'expired'
  const limitParam = parseInt(searchParams.get('limit') ?? '20', 10);
  const limit = Math.min(Math.max(1, isNaN(limitParam) ? 20 : limitParam), DOCUMENT_LIMIT_MAX);

  const documentTypes = ['document.created', 'document.amended'] as const;

  try {
    // Build base conditions
    const typeConditions = [inArray(attestations.type, [...documentTypes])];

    // Role filter: which attestations to show
    if (roleFilter === 'creator') {
      typeConditions.push(eq(attestations.issuerDid, callerDid));
    } else if (roleFilter === 'signer') {
      // Find attestations where caller has a signature row
      const signerAtts = await db
        .select({ attestationId: attestationSignatures.attestationId })
        .from(attestationSignatures)
        .where(eq(attestationSignatures.signerDid, callerDid));
      const attIds = signerAtts.map((r) => r.attestationId);
      if (attIds.length === 0) {
        return NextResponse.json({ documents: [], count: 0 }, { headers: cors });
      }
      typeConditions.push(inArray(attestations.id, attIds));
    } else {
      // 'all' — creator OR signer
      const signerAtts = await db
        .select({ attestationId: attestationSignatures.attestationId })
        .from(attestationSignatures)
        .where(eq(attestationSignatures.signerDid, callerDid));
      const attIds = signerAtts.map((r) => r.attestationId);
      typeConditions.push(
        or(
          eq(attestations.issuerDid, callerDid),
          attIds.length > 0 ? inArray(attestations.id, attIds) : sql`false`
        )!
      );
    }

    if (statusFilter) {
      typeConditions.push(eq(attestations.attestationStatus, statusFilter));
    }

    const rows = await db
      .select()
      .from(attestations)
      .where(and(...typeConditions))
      .orderBy(desc(attestations.issuedAt))
      .limit(limit);

    // Count signatures per document
    const attIds = rows.map((r) => r.id);
    let sigCounts: { attestationId: string; status: string; count: number }[] = [];
    if (attIds.length > 0) {
      sigCounts = await db
        .select({
          attestationId: attestationSignatures.attestationId,
          status: attestationSignatures.status,
          count: sql<number>`count(*)`,
        })
        .from(attestationSignatures)
        .where(inArray(attestationSignatures.attestationId, attIds))
        .groupBy(attestationSignatures.attestationId, attestationSignatures.status);
    }

    const countMap = new Map<string, { signed: number; declined: number; pending: number }>();
    for (const row of rows) {
      countMap.set(row.id, { signed: 0, declined: 0, pending: 0 });
    }
    for (const sc of sigCounts) {
      const existing = countMap.get(sc.attestationId);
      if (existing) {
        if (sc.status === 'signed') existing.signed = sc.count;
        if (sc.status === 'declined') existing.declined = sc.count;
        if (sc.status === 'pending') existing.pending = sc.count;
      }
    }

    const documents = rows.map((att) => ({
      ...att,
      signatureCounts: countMap.get(att.id) ?? { signed: 0, declined: 0, pending: 0 },
    }));

    return NextResponse.json({ documents, count: documents.length }, { headers: cors });
  } catch (error) {
    log.error({ err: String(error) }, 'Documents GET error');
    return NextResponse.json({ error: 'Failed to query documents' }, { status: 500, headers: cors });
  }
}
