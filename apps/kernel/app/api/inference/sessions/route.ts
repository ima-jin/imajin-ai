import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { resolveInferenceOwnerDid } from '@/src/lib/inference/route-auth';
import { db, inferenceSessions } from '@/src/db';
import { eq, and, desc } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

/**
 * GET /api/inference/sessions
 *
 * List inference sessions for the authenticated DID.
 * Optional query params:
 *   status   — filter by status (e.g. 'pending_confirm', 'resolved')
 *   limit    — max results (default 50, max 200)
 */
export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);

  const ownerResult = await resolveInferenceOwnerDid(request, 'inference:read', cors);
  if (!('ownerDid' in ownerResult)) return ownerResult;
  const { ownerDid } = ownerResult;

  const { searchParams } = new URL(request.url);
  const statusFilter = searchParams.get('status');
  const limit = Math.min(Number.parseInt(searchParams.get('limit') ?? '50', 10) || 50, 200);

  const where = statusFilter
    ? and(eq(inferenceSessions.ownerDid, ownerDid), eq(inferenceSessions.status, statusFilter))
    : eq(inferenceSessions.ownerDid, ownerDid);

  const rows = await db
    .select({
      id: inferenceSessions.id,
      vocabularyName: inferenceSessions.vocabularyName,
      assetId: inferenceSessions.assetId,
      chosenIntentType: inferenceSessions.chosenIntentType,
      consentTier: inferenceSessions.consentTier,
      status: inferenceSessions.status,
      createdAt: inferenceSessions.createdAt,
      updatedAt: inferenceSessions.updatedAt,
    })
    .from(inferenceSessions)
    .where(where)
    .orderBy(desc(inferenceSessions.createdAt))
    .limit(limit);

  return NextResponse.json({ count: rows.length, sessions: rows }, { headers: cors });
}
