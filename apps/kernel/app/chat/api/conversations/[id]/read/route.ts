import { NextRequest, NextResponse } from 'next/server';
import { db, conversationReadsV2 } from '@/src/db';
import { sql } from 'drizzle-orm';
import { getSessionFromCookies } from '@/src/lib/kernel/session';

/**
 * POST /api/conversations/:id/read
 * Marks a v2 conversation as read.
 * :id is a URL-encoded conversation DID.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSessionFromCookies(req.headers.get('cookie'));
    if (!session?.did) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    const conversationDid = decodeURIComponent(id);

    await db
      .insert(conversationReadsV2)
      .values({
        conversationDid,
        did: session.did,
        lastReadAt: sql`NOW()`,
      })
      .onConflictDoUpdate({
        target: [conversationReadsV2.conversationDid, conversationReadsV2.did],
        set: { lastReadAt: sql`NOW()` },
      });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error marking conversation as read:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
