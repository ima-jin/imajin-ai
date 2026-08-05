import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders } from '@imajin/config';
import { getChainByImajinDid } from '@/src/lib/auth/dfos';
import { verifyChainLog } from '@/src/lib/auth/chain-providers';
import { buildDidDocument } from '@/src/lib/auth/did-document';
import { createLogger } from '@imajin/logger';
import { nodeUrl } from '@/src/lib/http/node-url';

const log = createLogger('kernel');

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * GET /auth/api/identity/:did/did.json
 * Public endpoint — returns a W3C DID Document for a did:imajin DID.
 *
 * RFC-40 §4 Transport #1 (hosted, chain-log-returning) + DID Document view.
 *
 * The document is derived from cryptographically verifying the identity's
 * DFOS chain log. It is NOT derived from the database row directly — the
 * database is only used to locate the chain; trust comes from verification.
 *
 * Content-Type: application/did+json (W3C DID spec §7.1.2)
 *
 * Returns 404 when:
 *   - The DID has no associated chain (chain-unverified DIDs cannot produce
 *     a sovereign DID Document — RFC-40 design invariant).
 * Returns 410 when:
 *   - The chain exists but has been revoked/deleted.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ did: string }> }
) {
  const cors = corsHeaders(request);
  try {
    const { did } = await params;
    const imajinDid = decodeURIComponent(did);

    const chain = await getChainByImajinDid(imajinDid);
    if (!chain) {
      return NextResponse.json(
        {
          error: 'No chain found for this DID — cannot produce a chain-verified DID Document',
          did: imajinDid,
        },
        { status: 404, headers: cors }
      );
    }

    // Re-verify the chain log — trust comes from the chain, not the DB row.
    const result = await verifyChainLog(chain.log as string[]);

    if (!result.valid || result.isDeleted) {
      return NextResponse.json(
        {
          error: result.isDeleted ? 'DID has been revoked' : 'Chain verification failed',
          did: imajinDid,
        },
        { status: result.isDeleted ? 410 : 422, headers: cors }
      );
    }

    // A cold verifier is told to FOLLOW this endpoint and re-verify the chain
    // itself, so a malformed origin breaks resolution outright (#1614).
    const chainEndpoint = `${nodeUrl()}/auth/api/identity/${encodeURIComponent(imajinDid)}/chain`;

    const doc = buildDidDocument(imajinDid, result, {
      chainEndpoint,
      dfosDid: chain.dfosDid,
      headCid: chain.headCid,
    });

    if (!doc) {
      return NextResponse.json(
        { error: 'Could not derive DID Document from chain — no verification keys found' },
        { status: 422, headers: cors }
      );
    }

    return new NextResponse(JSON.stringify(doc), {
      status: 200,
      headers: {
        ...cors,
        'Content-Type': 'application/did+json',
        'Cache-Control': 'public, max-age=300, stale-while-revalidate=60',
      },
    });
  } catch (error) {
    log.error({ err: String(error) }, '[did.json] Error resolving DID Document');
    return NextResponse.json(
      { error: 'Failed to resolve DID Document' },
      { status: 500, headers: cors }
    );
  }
}
