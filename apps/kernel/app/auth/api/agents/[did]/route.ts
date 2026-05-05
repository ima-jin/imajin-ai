import { NextRequest, NextResponse } from 'next/server';
import { db, identityMembers } from '@/src/db';
import { eq, and, isNull } from 'drizzle-orm';
import { requireAuth } from '@imajin/auth';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

interface RouteParams {
  params: Promise<{ did: string }>;
}

/**
 * DELETE /auth/api/agents/:did
 * Revoke an agent by removing the identity_members link.
 * The identity itself is preserved; the agent just can no longer act on behalf of the user.
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }
  const { identity: caller } = authResult;

  const { did: agentDid } = await params;

  if (!agentDid || !agentDid.startsWith('did:imajin:')) {
    return NextResponse.json({ error: 'Invalid DID' }, { status: 400 });
  }

  try {
    // Verify the caller owns this agent
    const [membership] = await db
      .select({ role: identityMembers.role })
      .from(identityMembers)
      .where(
        and(
          eq(identityMembers.identityDid, agentDid),
          eq(identityMembers.memberDid, caller.id),
          isNull(identityMembers.removedAt)
        )
      )
      .limit(1);

    if (!membership) {
      return NextResponse.json(
        { error: 'Agent not found or not owned by you' },
        { status: 404 }
      );
    }

    if (membership.role !== 'owner') {
      return NextResponse.json(
        { error: 'Only owners can revoke agents' },
        { status: 403 }
      );
    }

    // Soft-delete the membership link
    await db
      .update(identityMembers)
      .set({ removedAt: new Date() })
      .where(
        and(
          eq(identityMembers.identityDid, agentDid),
          eq(identityMembers.memberDid, caller.id),
          isNull(identityMembers.removedAt)
        )
      );

    return NextResponse.json({ revoked: true });
  } catch (error) {
    log.error({ err: String(error), agentDid }, '[agents] Revoke error');
    return NextResponse.json({ error: 'Failed to revoke agent' }, { status: 500 });
  }
}
