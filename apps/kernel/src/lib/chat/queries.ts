/**
 * In-process chat query/command lib (#1393).
 *
 * DID-scoped functions for listing conversations, reading messages, and sending
 * a text message. Extracted from the chat REST route handlers so that both the
 * routes (app/chat/api/conversations/**) and the MCP messages connector
 * (src/lib/mcp/tools/messages.ts) share ONE implementation — no HTTP self-calls,
 * no duplicated logic. Mirrors the media in-process-lib convention.
 *
 * All functions act only on the caller's own DID and gate conversation access
 * through checkAccess(). Sends preserve the original route side effects:
 * `message.send` publish, WebSocket broadcast, and @mention processing.
 */
import { publish } from '@imajin/bus';
import { getClient } from '@imajin/db';
import { isVerifiedTier } from '@imajin/auth';
import { eq, and, desc, lt, isNull, inArray } from 'drizzle-orm';
import {
  db,
  conversationsV2,
  messagesV2,
  conversationReadsV2,
  messageReactionsV2,
} from '@/src/db';
import { checkAccess } from '@/src/lib/kernel/access';
import { generateId } from '@/src/lib/kernel/utils';
import { lookupIdentity } from '@/src/lib/kernel/lookup';
import { parseConversationDid } from './conversation-did';
import { resolveDmConversationTarget } from './dm-guard';
import { countUnread, extractMessagePreview, resolveDmParticipant } from './conversation-helpers';
import { hasCapability, requiredCapability, CAPABILITY_MESSAGES, type Capability } from './capabilities';
import { processMentions } from './mentions';

const rawSql = getClient();

// ── List conversations ─────────────────────────────────────────────────────

export interface ConversationSummary {
  did: string;
  name: string | null;
  type: string;
  slug: string | undefined;
  createdBy: string;
  createdAt: Date | null;
  lastMessageAt: Date | null;
  lastMessagePreview: string;
  unread: number;
  otherParticipant: { did: string; handle: string | null; name: string | null } | null;
}

/**
 * List all v2 conversations `did` participates in, with DM enrichment
 * (other-participant identity, last-message preview, unread count). Same logic
 * the REST GET /api/conversations handler uses.
 */
export async function listConversations(did: string): Promise<ConversationSummary[]> {
  const effectiveDid = did;

  // Discover all conversation DIDs this user participates in.
  const [readRecords, sentMessages, createdConvs, podConvDids, memberConvDids] = await Promise.all([
    db
      .select()
      .from(conversationReadsV2)
      .where(eq(conversationReadsV2.did, effectiveDid)),
    db
      .selectDistinct({ conversationDid: messagesV2.conversationDid })
      .from(messagesV2)
      .where(eq(messagesV2.fromDid, effectiveDid)),
    db
      .select({ did: conversationsV2.did })
      .from(conversationsV2)
      .where(eq(conversationsV2.createdBy, effectiveDid)),
    rawSql`
      SELECT p.conversation_did
      FROM connections.pods p
      JOIN connections.pod_members pm ON pm.pod_id = p.id
      WHERE pm.did = ${effectiveDid}
        AND pm.removed_at IS NULL
        AND p.conversation_did IS NOT NULL
    `,
    rawSql`
      SELECT conversation_did
      FROM chat.conversation_members
      WHERE member_did = ${effectiveDid}
        AND left_at IS NULL
    `,
  ]);

  const didSet = new Set<string>([
    ...readRecords.map(r => r.conversationDid),
    ...sentMessages.map(m => m.conversationDid),
    ...createdConvs.map(c => c.did),
    ...podConvDids.map((r: Record<string, string>) => r.conversation_did),
    ...memberConvDids.map((r: Record<string, string>) => r.conversation_did),
  ]);

  if (didSet.size === 0) {
    return [];
  }

  const convs = await db
    .select()
    .from(conversationsV2)
    .where(inArray(conversationsV2.did, Array.from(didSet)))
    .orderBy(desc(conversationsV2.lastMessageAt));

  const readMap = new Map(readRecords.map(r => [r.conversationDid, r.lastReadAt]));

  return Promise.all(
    convs.map(async (conv) => {
      const parsed = parseConversationDid(conv.did);

      // Last message preview
      const [lastMsg] = await db
        .select()
        .from(messagesV2)
        .where(eq(messagesV2.conversationDid, conv.did))
        .orderBy(desc(messagesV2.createdAt))
        .limit(1);

      const lastReadAt = readMap.get(conv.did);
      const unread = await countUnread(conv.did, effectiveDid, lastReadAt);
      const lastMessagePreview = extractMessagePreview(lastMsg);
      const otherParticipant = await resolveDmParticipant(conv, effectiveDid, rawSql);

      return {
        did: conv.did,
        name: conv.name,
        type: parsed.type,
        slug: parsed.slug,
        createdBy: conv.createdBy,
        createdAt: conv.createdAt,
        lastMessageAt: conv.lastMessageAt,
        lastMessagePreview,
        unread,
        otherParticipant,
      };
    })
  );
}

// ── Read messages ──────────────────────────────────────────────────────────

export type MessageRow = typeof messagesV2.$inferSelect;
export type ReactionRow = typeof messageReactionsV2.$inferSelect;

export interface ReadMessagesResult {
  ok: true;
  messages: Array<MessageRow & { reactions: ReactionRow[] }>;
  hasMore: boolean;
}

export interface AccessDenied {
  ok: false;
  status: number;
  error: string;
}

/**
 * Read recent messages in `conversationDid` for `requesterDid`, newest-last.
 * Access-gated via checkAccess(). `limit` is clamped to 1–100 (default 50).
 */
export async function readConversationMessages(
  requesterDid: string,
  conversationDid: string,
  limit = 50,
  before?: string | null,
): Promise<ReadMessagesResult | AccessDenied> {
  const access = await checkAccess(requesterDid, conversationDid);
  if (!access.allowed) {
    return { ok: false, status: 404, error: 'Conversation not found or access denied' };
  }

  const boundedLimit = Math.min(Math.max(Number.isFinite(limit) ? limit : 50, 1), 100);

  let query = db
    .select()
    .from(messagesV2)
    .where(
      and(
        eq(messagesV2.conversationDid, conversationDid),
        isNull(messagesV2.deletedAt)
      )
    )
    .orderBy(desc(messagesV2.createdAt))
    .limit(boundedLimit);

  if (before) {
    const cursorMessage = await db.query.messagesV2.findFirst({
      where: eq(messagesV2.id, before),
    });
    if (cursorMessage?.createdAt) {
      query = db
        .select()
        .from(messagesV2)
        .where(
          and(
            eq(messagesV2.conversationDid, conversationDid),
            isNull(messagesV2.deletedAt),
            lt(messagesV2.createdAt, cursorMessage.createdAt)
          )
        )
        .orderBy(desc(messagesV2.createdAt))
        .limit(boundedLimit);
    }
  }

  const result = await query;

  // Fetch reactions
  const messageIds = result.map(m => m.id);
  const reactions = messageIds.length > 0
    ? await db
        .select()
        .from(messageReactionsV2)
        .where(inArray(messageReactionsV2.messageId, messageIds))
    : [];

  const reactionsByMessage = reactions.reduce<Record<string, ReactionRow[]>>((acc, r) => {
    if (!acc[r.messageId]) acc[r.messageId] = [];
    acc[r.messageId].push(r);
    return acc;
  }, {});

  const messages = result.reverse().map(m => ({
    ...m,
    reactions: reactionsByMessage[m.id] || [],
  }));

  return { ok: true, messages, hasMore: result.length === boundedLimit };
}

// ── Send message ───────────────────────────────────────────────────────────

export interface SendMessageParams {
  senderDid: string;
  senderTier?: string | null;
  senderHandle?: string | null;
  conversationDid: string;
  content: unknown;
  contentType?: string;
  replyToMessageId?: string | null;
  mediaType?: string | null;
  mediaPath?: string | null;
  mediaAssetId?: string | null;
  mediaMeta?: unknown;
  conversationName?: string | null;
  /** The other party in a DM, when the caller knows it (#1649, #855). */
  recipientDid?: string | null;
}

export type SendMessageResult =
  | { ok: true; message: MessageRow | null }
  | { ok: false; status: number; error: string; code?: string; required?: Capability };

/**
 * Send a message in `conversationDid` authored as `senderDid` (onBehalfOf).
 * Enforces verified-tier, capability, access, and content validation, then
 * emits `message.send`, broadcasts over the chat WebSocket, and processes
 * @mentions — identical to the REST POST handler.
 *
 * A DM key that is not the canonical `dmDid()` of the pair is rewritten before
 * anything is written, and opening a new DM thread requires an active
 * connection with the counterparty (#1649, #855).
 */
export async function sendConversationMessage(params: SendMessageParams): Promise<SendMessageResult> {
  const {
    senderDid,
    senderTier,
    senderHandle,
    content,
    replyToMessageId,
    mediaType,
    mediaPath,
    mediaAssetId,
    mediaMeta,
    conversationName,
  } = params;

  // Soft DIDs cannot send messages
  if (!isVerifiedTier(senderTier ?? undefined)) {
    return { ok: false, status: 403, error: 'Please verify your account to send messages' };
  }

  const target = await resolveDmConversationTarget({
    conversationDid: params.conversationDid,
    senderDid,
    recipientDid: params.recipientDid ?? null,
  });
  if (!target.ok) {
    return { ok: false, status: target.status, error: target.error };
  }
  const conversationDid = target.conversationDid;

  const access = await checkAccess(senderDid, conversationDid);
  if (!access.allowed) {
    return { ok: false, status: 404, error: 'Conversation not found or access denied' };
  }

  const contentObj = content as Record<string, unknown> | undefined;
  const earlyContentType = params.contentType || (contentObj?.type as string) || 'text';
  const required = requiredCapability(earlyContentType);
  // Capability tiers are a narrower set; higher tiers (steward/operator) are
  // all verified, so collapse them to 'established' for the capability check.
  const rawTier = senderTier ?? 'preliminary';
  const capabilityTier: 'soft' | 'preliminary' | 'established' =
    rawTier === 'soft' || rawTier === 'preliminary' ? rawTier : 'established';
  if (!hasCapability({ tier: capabilityTier }, required)) {
    return { ok: false, status: 403, error: CAPABILITY_MESSAGES[required], code: 'CAPABILITY_DENIED', required };
  }

  if (!content || typeof content !== 'object') {
    return { ok: false, status: 400, error: 'content is required and must be an object' };
  }

  const contentType = params.contentType || (contentObj?.type as string) || 'text';
  const validContentTypes = ['text', 'system', 'media', 'voice', 'location'];
  if (!validContentTypes.includes(contentType)) {
    return { ok: false, status: 400, error: `Invalid contentType: ${contentType}` };
  }

  // Auto-create conversation if it doesn't exist
  const existing = await db.query.conversationsV2.findFirst({
    where: eq(conversationsV2.did, conversationDid),
  });

  if (!existing) {
    const parsed = parseConversationDid(conversationDid);
    const name = conversationName || (parsed.type === 'unknown' ? conversationDid : `${parsed.type}:${parsed.slug ?? ''}`);
    await db.insert(conversationsV2).values({
      did: conversationDid,
      name,
      createdBy: senderDid,
    }).onConflictDoNothing();
  }

  // Validate reply if provided
  if (replyToMessageId) {
    const replyMessage = await db.query.messagesV2.findFirst({
      where: and(
        eq(messagesV2.id, replyToMessageId),
        eq(messagesV2.conversationDid, conversationDid)
      ),
    });
    if (!replyMessage) {
      return { ok: false, status: 404, error: 'Reply message not found' };
    }
  }

  const messageId = generateId('msg');

  await db.insert(messagesV2).values({
    id: messageId,
    conversationDid,
    fromDid: senderDid,
    content,
    contentType,
    replyToMessageId: replyToMessageId || null,
    mediaType: mediaType || null,
    mediaPath: mediaPath || null,
    mediaAssetId: mediaAssetId || null,
    mediaMeta: mediaMeta || null,
  });

  await db
    .update(conversationsV2)
    .set({ lastMessageAt: new Date(), updatedAt: new Date() })
    .where(eq(conversationsV2.did, conversationDid));

  const message = await db.query.messagesV2.findFirst({
    where: eq(messagesV2.id, messageId),
  });

  publish('message.send', { issuer: senderDid, subject: senderDid, scope: 'chat', payload: { conversationDid, messageId } }).catch(() => {});

  // Broadcast via WebSocket
  if (message) {
    const port = process.env.PORT || '3007';
    fetch(`http://localhost:${port}/__ws_broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: conversationDid, message }),
    }).catch(() => {});
  }

  // Detect and notify @mentions — fire and forget
  processMentions({
    conversationDid,
    messageId,
    senderDid,
    senderName: senderHandle || senderDid.slice(0, 16),
    content,
  });

  return { ok: true, message: message ?? null };
}

/**
 * Convenience wrapper for the MCP connector: send a plain TEXT message in
 * `conversationDid` onBehalfOf `senderDid`, looking the sender's tier/handle up
 * from the identity registry. Returns the same discriminated result shape.
 */
export async function sendTextMessageAsDid(
  senderDid: string,
  conversationDid: string,
  text: string,
): Promise<SendMessageResult> {
  const ident = await lookupIdentity(senderDid);
  return sendConversationMessage({
    senderDid,
    senderTier: ident?.tier ?? null,
    senderHandle: ident?.handle ?? null,
    conversationDid,
    content: { type: 'text', text },
    contentType: 'text',
  });
}
