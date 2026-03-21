import { NextRequest, NextResponse } from 'next/server';
import { db, identities } from '@/src/db';
import { eq } from 'drizzle-orm';
import { corsHeaders } from '@imajin/config';
import { getChainByImajinDid } from '@/lib/dfos';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * GET /api/identity/:did
 * Public endpoint — resolve a DID to its public key and metadata.
 * Returns: { did, publicKey, type, tier }
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ did: string }> }
) {
  const cors = corsHeaders(request);
  try {
    const { did } = await params;
    const decodedDid = decodeURIComponent(did);

    const [identity] = await db
      .select({
        id: identities.id,
        publicKey: identities.publicKey,
        type: identities.type,
        tier: identities.tier,
      })
      .from(identities)
      .where(eq(identities.id, decodedDid))
      .limit(1);

    if (!identity) {
      return NextResponse.json(
        { error: 'Identity not found' },
        { status: 404, headers: cors }
      );
    }

    const chain = await getChainByImajinDid(decodedDid);

    return NextResponse.json(
      {
        did: identity.id,
        publicKey: identity.publicKey,
        type: identity.type,
        tier: identity.tier,
        ...(chain ? { dfosDid: chain.dfosDid } : {}),
      },
      { headers: cors }
    );
  } catch (error) {
    console.error('Identity resolve error:', error);
    return NextResponse.json(
      { error: 'Failed to resolve identity' },
      { status: 500, headers: cors }
    );
  }
}
