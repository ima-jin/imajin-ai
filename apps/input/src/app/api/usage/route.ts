import { requireAuth } from '@imajin/auth';
import { NextRequest, NextResponse } from 'next/server';
import { getUsageStats } from '@/lib/metering';

/**
 * GET /api/usage
 *
 * Returns current rate limit usage for the authenticated DID.
 */
export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }
  const did = authResult.identity.id;

  return NextResponse.json({
    did,
    usage: getUsageStats(did),
  });
}
