import { NextRequest, NextResponse } from 'next/server';
import { db, identities } from '@/src/db';
import { eq } from 'drizzle-orm';
import { getChainByImajinDid } from '@/src/lib/auth/dfos';
import { verifyChainLog } from '@/src/lib/auth/chain-providers';
import { buildDidDocument } from '@/src/lib/auth/did-document';
import { createLogger } from '@imajin/logger';
import { nodeUrl } from '@/src/lib/http/node-url';

const log = createLogger('kernel');

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Accept',
    },
  });
}

/**
 * GET /.well-known/did-imajin/:id
 * Public endpoint — Transport #3 (well-known discovery) from RFC-40 §4.
 *
 * Allows a cold verifier to resolve a did:imajin DID without prior coordination:
 *   - Accepts full DID ("did:imajin:...") or bare identifier ("abc...")
 *   - Returns the W3C DID Document derived from the verified chain
 *   - The document includes the chain endpoint as an untrusted transport hint
 *
 * This is the resolver discovery entry point documented in RFC-40 §4 point 3.
 * A verifier finding this endpoint at /.well-known/did-imajin/ knows how to
 * resolve any did:imajin hosted on this node without a directory lookup.
 *
 * Responds with Content-Type: application/did+json (W3C DID spec §7.1.2).
 *
 * Trust model: this endpoint is dumb transport — no Imajin service is a trusted
 * third party in resolution. The verifier must re-verify the chain log returned
 * by GET /auth/api/identity/:did/chain to confirm the DID Document is authentic.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const rawId = decodeURIComponent(id);

    // Accept both "did:imajin:abc..." and bare "abc..."
    const imajinDid = rawId.startsWith('did:imajin:') ? rawId : `did:imajin:${rawId}`;

    // Verify the DID exists in our identity registry before attempting chain lookup
    const [identity] = await db
      .select({ id: identities.id })
      .from(identities)
      .where(eq(identities.id, imajinDid))
      .limit(1);

    if (!identity) {
      return NextResponse.json(
        { error: 'DID not found', did: imajinDid },
        {
          status: 404,
          headers: { 'Access-Control-Allow-Origin': '*' },
        }
      );
    }

    const chain = await getChainByImajinDid(imajinDid);
    if (!chain) {
      return NextResponse.json(
        {
          error: 'No chain found — cannot produce a sovereign DID Document for this DID',
          did: imajinDid,
          hint: 'This DID exists but has no associated DFOS chain. Chain-verified resolution is not available.',
        },
        {
          status: 404,
          headers: { 'Access-Control-Allow-Origin': '*' },
        }
      );
    }

    const result = await verifyChainLog(chain.log as string[]);

    if (!result.valid || result.isDeleted) {
      return NextResponse.json(
        {
          error: result.isDeleted ? 'DID has been revoked' : 'Chain verification failed',
          did: imajinDid,
        },
        {
          status: result.isDeleted ? 410 : 422,
          headers: { 'Access-Control-Allow-Origin': '*' },
        }
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
        {
          status: 422,
          headers: { 'Access-Control-Allow-Origin': '*' },
        }
      );
    }

    return new NextResponse(JSON.stringify(doc), {
      status: 200,
      headers: {
        'Content-Type': 'application/did+json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=300, stale-while-revalidate=60',
      },
    });
  } catch (error) {
    log.error({ err: String(error) }, '[.well-known/did-imajin] Error resolving DID');
    return NextResponse.json(
      { error: 'Failed to resolve DID' },
      {
        status: 500,
        headers: { 'Access-Control-Allow-Origin': '*' },
      }
    );
  }
}
