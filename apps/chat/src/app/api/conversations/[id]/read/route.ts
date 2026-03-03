import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { conversationReads, participants } from '@/db/schema';
import { and, eq, sql } from 'drizzle-orm';

async function getSessionDid(req: NextRequest): Promise<string | null> {
  const cookie = req.cookies.get('imajin_session');
  if (!cookie) return null;

  const authUrl = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';
  try {
    const res = await fetch(`${authUrl}/api/session`, {
      headers: { Cookie: `imajin_session=${cookie.value}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.did || data.identity?.did || null;
  } catch {
    return null;
  }
}

/**
 * POST /api/conversations/:id/read
 * Marks a conversation as read by upserting the last_read_at timestamp
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const did = await getSessionDid(req);
    if (!did) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const conversationId = params.id;

    // Verify user is a participant in this conversation
    const participant = await db
      .select()
      .from(participants)
      .where(
        and(
          eq(participants.conversationId, conversationId),
          eq(participants.did, did)
        )
      )
      .limit(1);

    if (participant.length === 0) {
      return NextResponse.json(
        { error: 'Not a participant in this conversation' },
        { status: 403 }
      );
    }

    // Upsert the conversation_reads record
    await db
      .insert(conversationReads)
      .values({
        conversationId,
        did,
        lastReadAt: sql`NOW()`,
      })
      .onConflictDoUpdate({
        target: [conversationReads.conversationId, conversationReads.did],
        set: {
          lastReadAt: sql`NOW()`,
        },
      });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error marking conversation as read:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
