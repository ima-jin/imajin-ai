import { eq, and, ne, gt, sql } from 'drizzle-orm';
import { getClient } from '@imajin/db';
import { db, conversationsV2, messagesV2, conversationReadsV2 } from '@/src/db';
import { parseConversationDid } from '@/src/lib/chat/conversation-did';
import { lookupIdentity } from '@/src/lib/kernel/lookup';

type SqlClient = ReturnType<typeof getClient>;
type ConversationRow = typeof conversationsV2.$inferSelect;
type MessageRow = typeof messagesV2.$inferSelect;

/**
 * Count unread messages in a conversation for a given user.
 * If `lastReadAt` is provided, counts messages after that timestamp;
 * otherwise counts all messages not sent by the user.
 *
 * Cognitive complexity: 1 (≤ 15)
 */
export async function countUnread(
  conversationDid: string,
  effectiveDid: string,
  lastReadAt: Date | null | undefined,
): Promise<number> {
  if (lastReadAt) {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(messagesV2)
      .where(
        and(
          eq(messagesV2.conversationDid, conversationDid),
          gt(messagesV2.createdAt, lastReadAt),
          ne(messagesV2.fromDid, effectiveDid),
        ),
      );
    return row?.count ?? 0;
  }
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(messagesV2)
    .where(
      and(
        eq(messagesV2.conversationDid, conversationDid),
        ne(messagesV2.fromDid, effectiveDid),
      ),
    );
  return row?.count ?? 0;
}

/**
 * Extract a short text preview from the last message in a conversation.
 *
 * Cognitive complexity: 6 (≤ 15)
 */
export function extractMessagePreview(lastMsg: MessageRow | null | undefined): string {
  if (!lastMsg) return '';
  const c = lastMsg.content as Record<string, unknown>;
  if (c?.text && typeof c.text === 'string') return c.text.slice(0, 100);
  if (c?.type === 'media') return '[Media]';
  if (c?.type === 'voice') return '[Voice message]';
  if (c?.type === 'location') return '[Location]';
  return '';
}

/**
 * Resolve the other participant in a DM conversation.
 * Returns null for non-DM conversations or when the other party cannot be found.
 *
 * Discovery order:
 *   1. Messages from the other party
 *   2. Conversation reads from the other party
 *   3. conversation_members table
 *   4. Conversation createdBy field
 *
 * Cognitive complexity: 12 (≤ 15)
 */
export async function resolveDmParticipant(
  conv: ConversationRow,
  effectiveDid: string,
  rawSql: SqlClient,
): Promise<{ did: string; handle: string | null; name: string | null } | null> {
  if (parseConversationDid(conv.did).type !== 'dm') return null;

  let otherDid: string | undefined;

  // 1. Check messages from the other party
  const [otherMsg] = await db
    .select({ fromDid: messagesV2.fromDid })
    .from(messagesV2)
    .where(and(eq(messagesV2.conversationDid, conv.did), ne(messagesV2.fromDid, effectiveDid)))
    .limit(1);
  otherDid = otherMsg?.fromDid;

  // 2. Check conversation reads
  if (!otherDid) {
    const [otherRead] = await db
      .select({ did: conversationReadsV2.did })
      .from(conversationReadsV2)
      .where(and(eq(conversationReadsV2.conversationDid, conv.did), ne(conversationReadsV2.did, effectiveDid)))
      .limit(1);
    otherDid = otherRead?.did;
  }

  // 3. Check conversation_members table (raw SQL — not in Drizzle schema for this app)
  if (!otherDid) {
    const otherMembers = await rawSql`
      SELECT member_did FROM chat.conversation_members
      WHERE conversation_did = ${conv.did}
        AND member_did != ${effectiveDid}
      LIMIT 1
    `;
    if (otherMembers.length > 0) {
      otherDid = otherMembers[0].member_did as string;
    }
  }

  // 4. Fallback: createdBy (if it isn't us, they're the other party)
  if (!otherDid && conv.createdBy !== effectiveDid) {
    otherDid = conv.createdBy;
  }

  if (!otherDid) return null;

  try {
    const ident = await lookupIdentity(otherDid);
    if (ident) {
      return { did: otherDid, handle: ident.handle || null, name: ident.name || null };
    }
  } catch {
    // ignore lookup failures
  }

  return null;
}
