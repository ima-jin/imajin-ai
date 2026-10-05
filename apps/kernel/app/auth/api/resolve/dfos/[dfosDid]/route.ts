import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders } from '@imajin/config';
import { getIdentityByDfosDid } from '@/src/lib/auth/dfos';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

export { preflight as OPTIONS } from '@/app/auth/lib/preflight';

/**
 * GET /api/resolve/dfos/:dfosDid
 * Public endpoint — resolve a did:dfos to its linked did:imajin identity.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ dfosDid: string }> }
) {
  const cors = corsHeaders(request);
  try {
    const { dfosDid } = await params;
    const decodedDid = decodeURIComponent(dfosDid);

    const identity = await getIdentityByDfosDid(decodedDid);
    if (!identity) {
      return NextResponse.json(
        { error: 'No Imajin identity linked to this DFOS DID' },
        { status: 404, headers: cors }
      );
    }

    return NextResponse.json(identity, { headers: cors });
  } catch (err) {
    log.error({ err: String(err) }, '[resolve] Error resolving DFOS DID');
    return NextResponse.json(
      { error: 'Internal error' },
      { status: 500, headers: cors }
    );
  }
}
