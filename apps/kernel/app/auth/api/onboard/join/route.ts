/**
 * POST /auth/api/onboard/join
 *
 * Adds the authenticated user as a member of a group identity.
 * Used when a logged-in user visits an onboard link — they don't need
 * to re-onboard, just join.
 */
import { NextRequest, NextResponse } from 'next/server';
import { eq, and } from 'drizzle-orm';
import { db, identities, identityMembers } from '@/src/db';
import { getSessionFromCookies } from '@/src/lib/kernel/session';
import { withLogger } from '@imajin/logger';
import { publish } from '@imajin/bus';

export const POST = withLogger('kernel', async (request: NextRequest, { log }) => {
  const session = await getSessionFromCookies(request.headers.get('cookie'));
  if (!session?.did) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const { scopeDid } = body;

  if (!scopeDid) {
    return NextResponse.json({ error: 'scopeDid is required' }, { status: 400 });
  }

  // Verify the target identity exists and is a non-actor scope
  const [identity] = await db
    .select({ scope: identities.scope, name: identities.name })
    .from(identities)
    .where(eq(identities.id, scopeDid))
    .limit(1);

  if (!identity) {
    return NextResponse.json({ error: 'Identity not found' }, { status: 404 });
  }

  if (identity.scope === 'actor') {
    return NextResponse.json({ error: 'Cannot join an actor identity' }, { status: 400 });
  }

  // Check if already a member
  const [existing] = await db
    .select({ removedAt: identityMembers.removedAt })
    .from(identityMembers)
    .where(and(
      eq(identityMembers.identityDid, scopeDid),
      eq(identityMembers.memberDid, session.did)
    ))
    .limit(1);

  if (existing && !existing.removedAt) {
    return NextResponse.json({ already: true, message: 'Already a member' });
  }

  try {
    if (!existing) {
      await db.insert(identityMembers).values({
        identityDid: scopeDid,
        memberDid: session.did,
        role: 'member',
        addedBy: scopeDid,
      });
    } else {
      // Re-add previously removed member
      await db.update(identityMembers)
        .set({ removedAt: null, role: 'member', addedBy: scopeDid, addedAt: new Date() })
        .where(and(
          eq(identityMembers.identityDid, scopeDid),
          eq(identityMembers.memberDid, session.did)
        ));
    }

    publish('identity.member_added', {
      issuer: scopeDid,
      subject: session.did,
      scope: 'auth',
      payload: { context_id: scopeDid, context_type: 'forest' },
    }).catch((err: unknown) => {
      log.error({ err: String(err) }, 'Bus publish failed (non-fatal)');
    });

    log.info({ scopeDid, memberDid: session.did }, 'User joined identity via onboard');

    return NextResponse.json({ joined: true });
  } catch (err) {
    log.error({ err: String(err) }, 'Failed to add member');
    return NextResponse.json({ error: 'Failed to join' }, { status: 500 });
  }
});
