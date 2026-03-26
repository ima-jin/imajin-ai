import { SESSION_COOKIE_NAME } from "@imajin/config";
import { NextRequest, NextResponse } from 'next/server';
import { db, conversationReadsV2, messagesV2 } from '@/db';
import { getClient } from '@imajin/db';
import { eq } from 'drizzle-orm';
import { corsHeaders, corsOptions } from '@/lib/utils';

const rawSql = getClient();

async function getSessionDid(req: NextRequest): Promise<string | null> {
  const cookie = req.cookies.get(SESSION_COOKIE_NAME);
  if (!cookie) return null;

  const authUrl = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';
  try {
    const res = await fetch(`${authUrl}/api/session`, {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${cookie.value}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.did || data.identity?.did || null;
  } catch {
    return null;
  }
}

export async function OPTIONS(req: NextRequest) {
  return corsOptions(req);
}

/**
 * GET /api/conversations/unread
 * Returns total unread count and per-conversation unread counts (v2)
 */
export async function GET(req: NextRequest) {
  const cors = corsHeaders(req);
  try {
    const did = await getSessionDid(req);
    if (!did) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: cors });
    }

    // Discover all conversation DIDs this user is involved in
    const [readRecords, sentMessages, createdConvs, podConvDids] = await Promise.all([
      db
        .select()
        .from(conversationReadsV2)
        .where(eq(conversationReadsV2.did, did)),
      db
        .selectDistinct({ conversationDid: messagesV2.conversationDid })
        .from(messagesV2)
        .where(eq(messagesV2.fromDid, did)),
      db
        .select({ did: conversationReadsV2.conversationDid })
        .from(conversationReadsV2)
        .where(eq(conversationReadsV2.did, did)),
      rawSql`
        SELECT p.conversation_did
        FROM connections.pods p
        JOIN connections.pod_members pm ON pm.pod_id = p.id
        WHERE pm.did = ${did}
          AND pm.removed_at IS NULL
          AND p.conversation_did IS NOT NULL
      `,
    ]);

    const didSet = new Set<string>([
      ...readRecords.map(r => r.conversationDid),
      ...sentMessages.map(m => m.conversationDid),
      ...createdConvs.map(c => c.did),
      ...podConvDids.map((r: Record<string, string>) => r.conversation_did),
    ]);

    if (didSet.size === 0) {
      return NextResponse.json({ total: 0, conversations: [] }, { headers: cors });
    }

    const conversationDids = Array.from(didSet);

    const unreadRows = await rawSql<{ conversation_did: string; unread: number }[]>`
      SELECT m.conversation_did, count(*)::int as unread
      FROM chat.messages_v2 m
      LEFT JOIN chat.conversation_reads_v2 cr
        ON cr.conversation_did = m.conversation_did AND cr.did = ${did}
      WHERE m.conversation_did = ANY(${conversationDids})
        AND m.from_did != ${did}
        AND m.created_at > COALESCE(cr.last_read_at, '-infinity'::timestamptz)
      GROUP BY m.conversation_did
    `;

    const unreadCounts = unreadRows.map(r => ({ id: r.conversation_did, unread: r.unread }));

    const conversationsWithUnread = unreadCounts.filter((c) => c.unread > 0);
    const total = conversationsWithUnread.reduce((sum, c) => sum + c.unread, 0);

    return NextResponse.json({ total, conversations: conversationsWithUnread }, { headers: cors });
  } catch (error) {
    console.error('Error fetching unread counts:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500, headers: cors }
    );
  }
}
