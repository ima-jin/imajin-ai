import { eq, and, ne } from 'drizzle-orm';
import { db, conversationsV2, conversationMembers, messagesV2 } from '@/src/db';
import { parseConversationDid } from '@/src/lib/chat/conversation-did';
import { unfurlLinks } from '@/src/lib/chat/unfurl';

/**
 * Resolve the display name for a new conversation.
 * For event conversations, fetches the event title from the events service.
 * Falls back to "type:slug" for known non-event types, then the DID itself.
 *
 * Cognitive complexity: 11 (≤ 15)
 */
export async function resolveConversationName(
  did: string,
  conversationName?: string | null,
): Promise<string> {
  if (conversationName) return conversationName;
  const parsed = parseConversationDid(did);

  if (parsed.type === 'event') {
    try {
      const eventsUrl = process.env.EVENTS_SERVICE_URL || 'http://localhost:3006';
      const evtRes = await fetch(`${eventsUrl}/api/events/by-did/${encodeURIComponent(did)}`);
      if (evtRes.ok) {
        const evtData = await evtRes.json();
        return evtData.event?.title ? `${evtData.event.title} Lobby` : did;
      }
    } catch {}
  }

  if (parsed.type !== 'unknown' && parsed.type !== 'event') {
    return `${parsed.type}:${parsed.slug ?? ''}`;
  }

  return did;
}

/**
 * Ensure a conversation record exists and that `effectiveDid` is tracked as a member.
 * Idempotent — safe to call on every message send.
 *
 * Cognitive complexity: 1 (≤ 15)
 */
export async function ensureConversation(
  did: string,
  effectiveDid: string,
  conversationName?: string | null,
): Promise<void> {
  const existing = await db.query.conversationsV2.findFirst({
    where: eq(conversationsV2.did, did),
  });

  if (!existing) {
    const name = await resolveConversationName(did, conversationName);
    await db.insert(conversationsV2).values({
      did,
      name,
      createdBy: effectiveDid,
    }).onConflictDoNothing();
  }

  // Always ensure the sender is a conversation member (idempotent)
  await db.insert(conversationMembers).values({
    conversationDid: did,
    memberDid: effectiveDid,
    role: 'member',
  }).onConflictDoNothing();
}

/**
 * For DM conversations: ensure the other participant is tracked as a member.
 * No-op for non-DM conversation types.
 *
 * Discovery order:
 *   1. `recipientDid` if provided by the client
 *   2. Conversation `createdBy` (if it isn't the sender)
 *   3. First message from someone other than the sender
 *
 * Cognitive complexity: 7 (≤ 15)
 */
export async function ensureDmMembers(
  did: string,
  effectiveDid: string,
  recipientDid: string | null,
): Promise<void> {
  if (parseConversationDid(did).type !== 'dm') return;

  let otherDid = recipientDid;

  if (!otherDid) {
    const conv = await db.query.conversationsV2.findFirst({ where: eq(conversationsV2.did, did) });
    if (conv?.createdBy && conv.createdBy !== effectiveDid) {
      otherDid = conv.createdBy;
    }
  }

  if (!otherDid) {
    const [otherMsg] = await db
      .select({ fromDid: messagesV2.fromDid })
      .from(messagesV2)
      .where(and(eq(messagesV2.conversationDid, did), ne(messagesV2.fromDid, effectiveDid)))
      .limit(1);
    otherDid = otherMsg?.fromDid ?? null;
  }

  if (otherDid) {
    await db.insert(conversationMembers).values({
      conversationDid: did,
      memberDid: otherDid,
      role: 'member',
    }).onConflictDoNothing();
  }
}

/**
 * Extract a plain-text preview from a message content object.
 * Returns the text content or empty string for non-text content.
 *
 * Cognitive complexity: 4 (≤ 15)
 */
export function resolvePreviewText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (typeof content === 'object' && content !== null && 'text' in content) {
    return String((content as Record<string, unknown>).text);
  }
  return '';
}

/**
 * Fire-and-forget: unfurl link previews for a text message and broadcast the update.
 * Never throws — all errors are silently swallowed.
 *
 * Cognitive complexity: 3 (≤ 15)
 */
export function triggerLinkUnfurl(
  message: { id: string; [key: string]: unknown } | null | undefined,
  content: unknown,
  contentType: string,
  conversationDid: string,
  messageId: string,
): void {
  if (!message || contentType !== 'text' || typeof content !== 'string') return;
  unfurlLinks(content).then(async (previews) => {
    if (previews.length === 0) return;
    await db
      .update(messagesV2)
      .set({ linkPreviews: previews })
      .where(eq(messagesV2.id, messageId));
    const port = process.env.PORT || '3007';
    fetch(`http://localhost:${port}/__ws_broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: conversationDid,
        type: 'message_updated',
        message: { ...message, linkPreviews: previews },
      }),
    }).catch(() => {});
  }).catch(() => {});
}
