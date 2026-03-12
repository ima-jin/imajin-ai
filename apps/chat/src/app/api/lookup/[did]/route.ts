import { NextRequest, NextResponse } from 'next/server';

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL!;

/**
 * GET /api/lookup/:did - Resolve a DID to handle/name
 * Proxies to auth service's lookup endpoint
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ did: string }> }
) {
  const { did } = await params;

  // Soft DID (did:email:user@example.com) — derive display name from email, no auth lookup needed
  if (did.startsWith('did:email:')) {
    const email = decodeURIComponent(did.slice('did:email:'.length));
    return NextResponse.json({ did, name: email, handle: null });
  }

  try {
    const res = await fetch(`${AUTH_SERVICE_URL}/api/lookup/${encodeURIComponent(did)}`);
    if (!res.ok) {
      return NextResponse.json({ did }, { status: 200 });
    }
    const data = await res.json();
    const identity = data.identity || data;
    return NextResponse.json({
      did: identity.id || did,
      handle: identity.handle || null,
      name: identity.name || null,
    });
  } catch {
    return NextResponse.json({ did }, { status: 200 });
  }
}
