import { NextRequest, NextResponse } from 'next/server';
import { db, profiles } from '@/db';
import { eq } from 'drizzle-orm';

/**
 * GET /api/presence/:did
 * Get online status and last seen for a user
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { did: string } }
) {
  try {
    const { did } = params;

    if (!did) {
      return NextResponse.json(
        { error: 'Missing DID' },
        { status: 400 }
      );
    }

    const profile = await db
      .select({
        lastSeenAt: profiles.lastSeenAt,
      })
      .from(profiles)
      .where(eq(profiles.did, did))
      .limit(1);

    if (profile.length === 0) {
      return NextResponse.json(
        { error: 'Profile not found' },
        { status: 404 }
      );
    }

    const lastSeen = profile[0].lastSeenAt;

    // Consider online if last_seen is null or within last 60 seconds
    const isOnline = !lastSeen ||
      (new Date().getTime() - new Date(lastSeen).getTime() < 60000);

    return NextResponse.json({
      online: isOnline,
      lastSeen: lastSeen ? lastSeen.toISOString() : null,
    });
  } catch (err) {
    console.error('[Presence] Get error:', err);
    return NextResponse.json(
      { error: 'Failed to get presence' },
      { status: 500 }
    );
  }
}
