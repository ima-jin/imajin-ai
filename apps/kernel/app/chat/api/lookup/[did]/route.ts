import { NextRequest, NextResponse } from 'next/server';
import { lookupIdentity } from '@/src/lib/kernel/lookup';

/**
 * GET /api/lookup/:did - Resolve a DID to handle/name
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ did: string }> }
) {
  const { did } = await params;

  try {
    const identity = await lookupIdentity(did);
    if (!identity) {
      return NextResponse.json({ did, tier: null }, { status: 200 });
    }
    return NextResponse.json({
      did: identity.did,
      handle: identity.handle || null,
      name: identity.name || null,
      tier: identity.tier || null,
    });
  } catch {
    return NextResponse.json({ did, tier: null }, { status: 200 });
  }
}
