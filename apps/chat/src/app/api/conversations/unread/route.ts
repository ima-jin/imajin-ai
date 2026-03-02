import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { conversationReads, messages, participants } from '@/db/schema';
import { and, eq, gt, sql } from 'drizzle-orm';

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
 * GET /api/conversations/unread
 * Returns total unread count and per-conversation unread counts
 */
export async function GET(req: NextRequest) {
  try {
    const did = await getSessionDid(req);
    if (!did) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Get all conversations the user is a participant in
    const userConversations = await db
      .select({ conversationId: participants.conversationId })
      .from(participants)
      .where(eq(participants.did, did));

    const conversationIds = userConversations.map((p) => p.conversationId);

    if (conversationIds.length === 0) {
      return NextResponse.json({ total: 0, conversations: [] });
    }

    // For each conversation, count messages created after last_read_at
    const unreadCounts = await Promise.all(
      conversationIds.map(async (conversationId) => {
        // Get the last read timestamp for this conversation
        const readRecord = await db
          .select()
          .from(conversationReads)
          .where(
            and(
              eq(conversationReads.conversationId, conversationId),
              eq(conversationReads.did, did)
            )
          )
          .limit(1);

        const lastReadAt = readRecord[0]?.lastReadAt;

        // Count messages created after lastReadAt (or all messages if never read)
        let unreadCount = 0;

        if (lastReadAt) {
          const result = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(messages)
            .where(
              and(
                eq(messages.conversationId, conversationId),
                gt(messages.createdAt, lastReadAt)
              )
            );
          unreadCount = result[0]?.count || 0;
        } else {
          // Never read - count all messages not from this user
          const result = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(messages)
            .where(
              and(
                eq(messages.conversationId, conversationId),
                sql`${messages.fromDid} != ${did}`
              )
            );
          unreadCount = result[0]?.count || 0;
        }

        return {
          id: conversationId,
          unread: unreadCount,
        };
      })
    );

    // Filter out conversations with 0 unread
    const conversationsWithUnread = unreadCounts.filter((c) => c.unread > 0);
    const total = conversationsWithUnread.reduce((sum, c) => sum + c.unread, 0);

    return NextResponse.json({
      total,
      conversations: conversationsWithUnread,
    });
  } catch (error) {
    console.error('Error fetching unread counts:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
