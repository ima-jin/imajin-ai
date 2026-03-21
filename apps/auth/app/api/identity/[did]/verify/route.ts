import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders } from '@imajin/config';
import { db, identityChains, identities } from '@/src/db';
import { eq } from 'drizzle-orm';
import { verifyChain } from '@imajin/dfos';
import { hexToMultibase } from '@imajin/auth';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * GET /api/identity/:did/verify
 * Public endpoint — verify a DID's DFOS chain and check DB consistency.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ did: string }> }
) {
  const cors = corsHeaders(request);
  try {
    const { did } = await params;
    const decodedDid = decodeURIComponent(did);

    // Load identity
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

    // Load chain
    const [chain] = await db
      .select()
      .from(identityChains)
      .where(eq(identityChains.did, decodedDid))
      .limit(1);

    if (!chain) {
      return NextResponse.json({
        did: decodedDid,
        hasDfosChain: false,
        message: 'Identity exists but has no DFOS chain',
      }, { headers: cors });
    }

    // Verify chain
    let chainValid = false;
    let chainError: string | null = null;
    let verified: Awaited<ReturnType<typeof verifyChain>> | null = null;

    try {
      verified = await verifyChain(chain.log as string[]);
      chainValid = !verified.isDeleted;
    } catch (err: unknown) {
      chainError = err instanceof Error ? err.message : 'Chain verification failed';
    }

    // Check DB consistency
    let dbConsistent = false;
    if (verified && identity.publicKey) {
      const dbMultibase = hexToMultibase(identity.publicKey);
      const chainMultibase = verified.controllerKeys?.[0]?.publicKeyMultibase;
      dbConsistent = dbMultibase === chainMultibase;
    }

    return NextResponse.json({
      did: decodedDid,
      dfosDid: chain.dfosDid,
      hasDfosChain: true,
      chainValid,
      chainError,
      chainLength: (chain.log as string[]).length,
      currentKeys: verified ? {
        auth: verified.authKeys?.length ?? 0,
        assert: verified.assertKeys?.length ?? 0,
        controller: verified.controllerKeys?.length ?? 0,
      } : null,
      dbConsistent,
      isDeleted: verified?.isDeleted ?? null,
    }, { headers: cors });
  } catch (err) {
    console.error('[verify] Error:', err);
    return NextResponse.json(
      { error: 'Internal error' },
      { status: 500, headers: cors }
    );
  }
}
