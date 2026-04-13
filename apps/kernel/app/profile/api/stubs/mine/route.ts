import { NextRequest, NextResponse } from 'next/server';
import { db, identityMembers, profiles } from '@/src/db';
import { eq, and, isNull } from 'drizzle-orm';
import { requireAuth } from '@imajin/auth';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

/**
 * GET /api/stubs/mine
 * List stubs the authenticated caller maintains.
 */
export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }
  const { identity: caller } = authResult;

  try {
    const rows = await db
      .select({
        did: identityMembers.identityDid,
        role: identityMembers.role,
        name: profiles.displayName,
        handle: profiles.handle,
        metadata: profiles.metadata,
        claimStatus: profiles.claimStatus,
      })
      .from(identityMembers)
      .innerJoin(profiles, eq(profiles.did, identityMembers.identityDid))
      .where(
        and(
          eq(identityMembers.memberDid, caller.id),
          eq(identityMembers.role, 'maintainer'),
          isNull(identityMembers.removedAt)
        )
      );

    return NextResponse.json(rows);
  } catch (error) {
    log.error({ err: String(error) }, '[stubs/mine] List error');
    return NextResponse.json({ error: 'Failed to list maintained stubs' }, { status: 500 });
  }
}
