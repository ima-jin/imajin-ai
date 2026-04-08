import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders } from '@imajin/config';
import { getChainByImajinDid } from '@/src/lib/auth/dfos';
import { verifyChainLog } from '@/src/lib/auth/chain-providers';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * GET /api/identity/:did/chain
 * Public endpoint — serve the DFOS identity chain for a DID.
 * The log is a portable, self-verifying artifact.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ did: string }> }
) {
  const cors = corsHeaders(request);
  try {
    const { did } = await params;
    const decodedDid = decodeURIComponent(did);

    const chain = await getChainByImajinDid(decodedDid);
    if (!chain) {
      return NextResponse.json(
        { error: 'No DFOS chain found for this identity' },
        { status: 404, headers: cors }
      );
    }

    // Verify chain integrity before serving
    const result = await verifyChainLog(chain.log as string[]);

    return NextResponse.json({
      did: decodedDid,
      dfosDid: chain.dfosDid,
      log: chain.log,
      headCid: chain.headCid,
      keyCount: chain.keyCount,
      isDeleted: result.isDeleted ?? false,
    }, { headers: cors });
  } catch (err) {
    console.error('[chain] Error serving chain:', err);
    return NextResponse.json(
      { error: 'Internal error' },
      { status: 500, headers: cors }
    );
  }
}
