import { NextRequest, NextResponse } from 'next/server';
import { db, identityMembers, profiles } from '@/src/db';
import { eq, and, isNull } from 'drizzle-orm';
import { requireAuth } from '@imajin/auth';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

interface RouteParams {
  params: Promise<{ did: string }>;
}

/**
 * POST /api/stubs/:did/join
 * Join as a maintainer of an unclaimed stub.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { did } = await params;

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }
  const { identity: caller } = authResult;

  try {
    // Verify stub exists and is unclaimed
    const stub = await db.query.profiles.findFirst({
      where: (p, { eq }) => eq(p.did, did),
    });

    if (!stub) {
      return NextResponse.json({ error: 'Stub not found' }, { status: 404 });
    }
    if (stub.claimStatus !== 'unclaimed') {
      return NextResponse.json({ error: 'This place has already been claimed' }, { status: 409 });
    }

    // Check caller isn't already a member
    const [existing] = await db
      .select({ identityDid: identityMembers.identityDid })
      .from(identityMembers)
      .where(
        and(
          eq(identityMembers.identityDid, did),
          eq(identityMembers.memberDid, caller.id),
          isNull(identityMembers.removedAt)
        )
      )
      .limit(1);

    if (existing) {
      return NextResponse.json({ error: 'Already a maintainer of this place' }, { status: 409 });
    }

    // Insert maintainer membership
    await db.insert(identityMembers).values({
      identityDid: did,
      memberDid: caller.id,
      role: 'maintainer',
      addedBy: caller.id,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    log.error({ err: String(error) }, '[stubs/join] Error');
    return NextResponse.json({ error: 'Failed to join stub' }, { status: 500 });
  }
}
