import { NextRequest, NextResponse } from 'next/server';
import { authenticateCloudflare } from '@/src/lib/cloudflare/authority';
import { listCloudflareZoneGrants } from '@/src/lib/cloudflare/zone-grants';
import { CloudflareError } from '@/src/lib/cloudflare/schemas';
import { corsHeaders } from '@/src/lib/kernel/cors';

export const dynamic = 'force-dynamic';

/** Actual grantee only: no caller-selected DID, act-as identity or owner fallback. */
export async function GET(request: NextRequest) {
  const headers = { ...corsHeaders(request), 'Cache-Control': 'no-store' };
  try {
    const actor = await authenticateCloudflare(request);
    if (!actor.did) throw new CloudflareError(401, 'authentication_required');
    const grants = await listCloudflareZoneGrants(actor.did);
    return NextResponse.json({ grants }, { headers });
  } catch (error) {
    const known = error instanceof CloudflareError;
    return NextResponse.json({ error: known ? error.code : 'zone_grants_unavailable' },
      { status: known ? error.status : 503, headers });
  }
}

export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
