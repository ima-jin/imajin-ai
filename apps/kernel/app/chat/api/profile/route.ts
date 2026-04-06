import { NextRequest, NextResponse } from 'next/server';
import { db, profiles } from '@/src/db';
import { or, eq } from 'drizzle-orm';

/**
 * GET /api/profile?handle=xxx - Look up profile directly from DB
 * Used by new chat flow to search users
 */
export async function GET(request: NextRequest) {
  const handle = request.nextUrl.searchParams.get('handle');

  if (!handle) {
    return NextResponse.json({ error: 'handle parameter required' }, { status: 400 });
  }

  try {
    const profile = await db.query.profiles.findFirst({
      where: (p, { or, eq }) => or(eq(p.did, handle), eq(p.handle, handle)),
    });

    if (!profile) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    return NextResponse.json(profile);
  } catch (error) {
    console.error('Profile lookup failed:', error);
    return NextResponse.json({ error: 'Profile lookup failed' }, { status: 500 });
  }
}
