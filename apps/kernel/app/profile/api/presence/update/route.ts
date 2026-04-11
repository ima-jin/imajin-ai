import { NextRequest, NextResponse } from 'next/server';
import { db, profiles } from '@/src/db';
import { eq } from 'drizzle-orm';
import { withLogger } from '@imajin/logger';

/**
 * POST /api/presence/update
 * Update last_seen_at for a user going offline
 */
export const POST = withLogger('kernel', async (req: NextRequest, { log }) => {
  try {
    const { did, lastSeenAt } = await req.json();

    if (!did || !lastSeenAt) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      );
    }

    await db
      .update(profiles)
      .set({ lastSeenAt: new Date(lastSeenAt) })
      .where(eq(profiles.did, did));

    return NextResponse.json({ success: true });
  } catch (err) {
    log.error({ err: String(err) }, '[Presence] Update error');
    return NextResponse.json(
      { error: 'Failed to update presence' },
      { status: 500 }
    );
  }
});
