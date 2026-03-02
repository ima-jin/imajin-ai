import { NextRequest, NextResponse } from 'next/server';
import { db, participants } from '@/db';
import { eq } from 'drizzle-orm';

/**
 * GET /api/participants/:did/conversations
 * Get all conversation IDs for a participant (used for presence broadcasting)
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

    const convs = await db
      .select({
        conversationId: participants.conversationId,
      })
      .from(participants)
      .where(eq(participants.did, did));

    const conversationIds = convs.map(c => c.conversationId);

    return NextResponse.json({ conversationIds });
  } catch (err) {
    console.error('[Participants] Get conversations error:', err);
    return NextResponse.json(
      { error: 'Failed to get conversations' },
      { status: 500 }
    );
  }
}
