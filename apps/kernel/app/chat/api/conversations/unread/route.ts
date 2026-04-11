import { NextRequest, NextResponse } from 'next/server';
import { db, conversationReadsV2, messagesV2 } from '@/src/db';
import { getClient } from '@imajin/db';
import { eq } from 'drizzle-orm';
import { requireAuth } from '@imajin/auth';
import { corsOptions, corsHeaders } from "@/src/lib/kernel/cors";
import { withLogger } from '@imajin/logger';

const rawSql = getClient();

export async function OPTIONS(req: NextRequest) {
  return corsOptions(req);
}

/**
 * GET /api/conversations/unread
 * Returns total unread count and per-conversation unread counts (v2)
 */
export const GET = withLogger('kernel', async (req, { log }) => {
  const cors = corsHeaders(req);
  const authResult = await requireAuth(req);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }

  const { identity } = authResult;
  const effectiveDid = identity.actingAs || identity.id;

  try {
    // Discover all conversation DIDs this user is involved in
    const [readRecords, sentMessages, createdConvs, podConvDids] = await Promise.all([
      db
        .select()
        .from(conversationReadsV2)
        .where(eq(conversationReadsV2.did, effectiveDid)),
      db
        .selectDistinct({ conversationDid: messagesV2.conversationDid })
        .from(messagesV2)
        .where(eq(messagesV2.fromDid, effectiveDid)),
      db
        .select({ did: conversationReadsV2.conversationDid })
        .from(conversationReadsV2)
        .where(eq(conversationReadsV2.did, effectiveDid)),
      rawSql`
        SELECT p.conversation_did
        FROM connections.pods p
        JOIN connections.pod_members pm ON pm.pod_id = p.id
        WHERE pm.did = ${effectiveDid}
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
        ON cr.conversation_did = m.conversation_did AND cr.did = ${effectiveDid}
      WHERE m.conversation_did = ANY(${conversationDids})
        AND m.from_did != ${effectiveDid}
        AND m.created_at > COALESCE(cr.last_read_at, '-infinity'::timestamptz)
      GROUP BY m.conversation_did
    `;

    const unreadCounts = unreadRows.map(r => ({ id: r.conversation_did, unread: r.unread }));

    const conversationsWithUnread = unreadCounts.filter((c) => c.unread > 0);
    const total = conversationsWithUnread.reduce((sum, c) => sum + c.unread, 0);

    return NextResponse.json({ total, conversations: conversationsWithUnread }, { headers: cors });
  } catch (error) {
    log.error({ err: String(error) }, 'Error fetching unread counts');
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500, headers: cors }
    );
  }
});
