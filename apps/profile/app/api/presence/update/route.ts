import { NextRequest, NextResponse } from 'next/server';
import { db, profiles } from '@/db';
import { eq } from 'drizzle-orm';

/**
 * POST /api/presence/update
 * Update last_seen_at for a user going offline
 */
export async function POST(req: NextRequest) {
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
    console.error('[Presence] Update error:', err);
    return NextResponse.json(
      { error: 'Failed to update presence' },
      { status: 500 }
    );
  }
}
