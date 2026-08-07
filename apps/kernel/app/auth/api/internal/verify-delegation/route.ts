import { NextRequest, NextResponse } from 'next/server';
import { db, identityMembers } from '@/src/db';
import { eq, and, isNull } from 'drizzle-orm';

/**
 * POST /auth/api/internal/verify-delegation
 *
 * Internal-only endpoint (guarded by AUTH_INTERNAL_API_KEY) that checks
 * whether agentDid has an active (not revoked) role='agent' membership
 * on principalDid in identity_members.
 *
 * Used by ws-server.js to authorize register_also (#1653).
 */
export async function POST(request: NextRequest) {
  const internalKey = request.headers.get('x-internal-key');
  if (!internalKey || internalKey !== process.env.AUTH_INTERNAL_API_KEY) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { agentDid: string; principalDid: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { agentDid, principalDid } = body;
  if (!agentDid || !principalDid) {
    return NextResponse.json({ error: 'Missing agentDid or principalDid' }, { status: 400 });
  }

  // Check identity_members for an active agent delegation:
  // identityDid = principalDid (the identity being acted for)
  // memberDid = agentDid (the agent doing the acting)
  // role = 'agent'
  // removedAt IS NULL (not revoked)
  const [membership] = await db
    .select({ id: identityMembers.id })
    .from(identityMembers)
    .where(
      and(
        eq(identityMembers.identityDid, principalDid),
        eq(identityMembers.memberDid, agentDid),
        eq(identityMembers.role, 'agent'),
        isNull(identityMembers.removedAt),
      ),
    )
    .limit(1);

  return NextResponse.json({ allowed: !!membership });
}
