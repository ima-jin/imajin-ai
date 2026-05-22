import { NextRequest, NextResponse } from 'next/server';
import { db, attestations, attestationSignatures, assets } from '@/src/db';
import { eq, and, or, desc, sql, inArray } from 'drizzle-orm';
import { corsHeaders } from '@imajin/config';
import { requireAuth } from '@/src/lib/auth/middleware';
import { createLogger } from '@imajin/logger';
import {
  finalizeDocumentAttestation,
  parseDocumentRequestBody,
  validateDocumentRequestInput,
} from '../../../../src/lib/auth/document-attestation';
import { randomUUID } from 'node:crypto';

const log = createLogger('kernel:documents');

const DOCUMENT_LIMIT_MAX = 100;

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomUUID().replaceAll('-', '').slice(0, 12)}`;
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
  const parseResult = await parseDocumentRequestBody(request);
  if (!parseResult.ok) {
    return NextResponse.json({ error: parseResult.failure.error }, { status: parseResult.failure.status, headers: cors });
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
    expiry,
    callerIdentity,
  } = validationResult.input;

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
      authorJws,
      attestationStatus: 'collecting',
      documentHash,
      documentAssetId: documentAssetId,
      totalSigners: 1 + signerDids.length,
      issuedAt: new Date(),
      expiresAt,
    })
    .returning();

  const allSigs = await finalizeDocumentAttestation({
    attestationId,
    documentAssetId,
    creatorDid: callerDid,
    creatorJws: authorJws,
    signerDids,
    title,
    callerIdentity,
    genId,
    log,
  });

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
