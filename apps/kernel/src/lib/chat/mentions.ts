import { createLogger } from '@imajin/logger';
import { publish } from '@imajin/bus';
import { eq, and, isNull, ilike } from 'drizzle-orm';
import { db, conversationMembers, profiles } from '@/src/db';

const log = createLogger('kernel');

/**
 * Matches @handle in message text.
 * Must stay in sync with the frontend regex in packages/chat useMentions.
 */
export const MENTION_REGEX = /@([a-zA-Z0-9_-]+)/g;

/** Sentinel DID used by the frontend to represent @everyone. */
export const EVERYONE_DID = '__everyone__';

export interface StructuredMention {
  did: string;
  handle: string;
  index: number;
  length: number;
}

export interface MentionContext {
  conversationDid: string;
  messageId: string;
  senderDid: string;
  senderName: string;
  content: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export async function resolveHandleToDid(handle: string): Promise<string | null> {
  try {
    const result = await db
      .select({ did: profiles.did, handle: profiles.handle })
      .from(profiles)
      .where(ilike(profiles.handle, handle))
      .limit(5);
    const profile = result.find((p) => p.handle?.toLowerCase() === handle.toLowerCase());
    return profile?.did ?? null;
  } catch {
    return null;
  }
}

function extractMessageText(content: unknown): string {
  if (typeof content === 'object' && content !== null && 'text' in content) {
    return String(content.text ?? '');
  }
  if (typeof content === 'string') return content;
  return '';
}

function parseStructuredMentions(content: unknown): StructuredMention[] {
  if (typeof content !== 'object' || content === null) return [];
  const mentions = (content as Record<string, unknown>).mentions;
  if (!Array.isArray(mentions)) return [];
  return mentions.filter(
    (m): m is StructuredMention =>
      typeof m === 'object' &&
      m !== null &&
      typeof (m as Record<string, unknown>).did === 'string' &&
      typeof (m as Record<string, unknown>).handle === 'string',
  );
}

/**
 * Validate that a structured mention actually appears in the message text.
 * Prevents clients from sending notifications to arbitrary DIDs.
 */
function validateMention(mention: StructuredMention, text: string): boolean {
  if (mention.did === EVERYONE_DID) {
    return text.includes('@everyone');
  }
  const expected = `@${mention.handle}`;
  // Prefer positional check when the client provides a valid index
  if (typeof mention.index === 'number' && mention.index >= 0) {
    return text.slice(mention.index, mention.index + expected.length) === expected;
  }
  return text.includes(expected);
}

function publishMention(ctx: MentionContext, messageText: string, targetDid: string): Promise<void> {
  return publish('chat.mention', {
    issuer: ctx.senderDid,
    subject: targetDid,
    scope: 'chat',
    payload: {
      conversationId: ctx.conversationDid,
      messageId: ctx.messageId,
      senderName: ctx.senderName,
      messagePreview: messageText.slice(0, 100),
      interestDids: [targetDid],
    },
  }).catch((err: unknown) => {
    log.error({ err: String(err) }, 'Mention publish error');
  });
}

async function processEveryoneMention(ctx: MentionContext, messageText: string): Promise<void> {
  const [callerMembership] = await db
    .select({ role: conversationMembers.role })
    .from(conversationMembers)
    .where(
      and(
        eq(conversationMembers.conversationDid, ctx.conversationDid),
        eq(conversationMembers.memberDid, ctx.senderDid),
        isNull(conversationMembers.leftAt),
      ),
    );

  if (!callerMembership || (callerMembership.role !== 'owner' && callerMembership.role !== 'admin')) {
    return;
  }

  const allMembers = await db
    .select({ memberDid: conversationMembers.memberDid })
    .from(conversationMembers)
    .where(
      and(
        eq(conversationMembers.conversationDid, ctx.conversationDid),
        isNull(conversationMembers.leftAt),
      ),
    );

  await Promise.allSettled(
    allMembers
      .filter((m) => m.memberDid !== ctx.senderDid)
      .map((m) => publishMention(ctx, messageText, m.memberDid)),
  );
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Process @mentions for a message — fire and forget.
 *
 * Handles structured mentions from the typeahead picker (with server-side
 * validation and deduplication) and falls back to regex parsing for
 * plain-text clients that don't send a mentions array.
 */
export function processMentions(ctx: MentionContext): void {
  const messageText = extractMessageText(ctx.content);
  const structuredMentions = parseStructuredMentions(ctx.content);

  if (structuredMentions.length > 0) {
    (async () => {
      const seen = new Set<string>();
      for (const mention of structuredMentions) {
        if (!validateMention(mention, messageText)) continue;
        if (seen.has(mention.did)) continue;
        seen.add(mention.did);

        try {
          if (mention.did === EVERYONE_DID) {
            await processEveryoneMention(ctx, messageText);
          } else if (mention.did !== ctx.senderDid) {
            publishMention(ctx, messageText, mention.did);
          }
        } catch (err) {
          log.error({ err: String(err) }, 'Mention processing error');
        }
      }
    })().catch(() => {});
  } else {
    // Regex fallback for clients that don't send structured mentions
    const matches = [...messageText.matchAll(new RegExp(MENTION_REGEX))].map((m) => m[1]);
    if (matches.length === 0) return;

    const uniqueHandles = [...new Set<string>(matches)];
    (async () => {
      for (const handle of uniqueHandles) {
        try {
          const mentionedDid = await resolveHandleToDid(handle);
          if (!mentionedDid || mentionedDid === ctx.senderDid) continue;
          publishMention(ctx, messageText, mentionedDid);
        } catch (err) {
          log.error({ err: String(err) }, 'Handle resolution error');
        }
      }
    })().catch(() => {});
  }
}
