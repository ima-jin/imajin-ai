import { createLogger } from '@imajin/logger';
import { send } from '@imajin/notify';
import { db, conversationMembers, conversationsV2 } from '@/src/db';
import { eq, and, isNull, ne } from 'drizzle-orm';

const log = createLogger('kernel');

/**
 * Notify all conversation participants (except the sender) about a new message.
 * Fire-and-forget — errors are logged but never thrown.
 */
export function notifyMessageRecipients(opts: {
  conversationDid: string;
  senderDid: string;
  senderName: string;
  messagePreview: string;
}): void {
  const { conversationDid, senderDid, senderName, messagePreview } = opts;

  (async () => {
    // Get conversation name for notification title
    const [conv] = await db
      .select({ name: conversationsV2.name, type: conversationsV2.type })
      .from(conversationsV2)
      .where(eq(conversationsV2.did, conversationDid))
      .limit(1);

    // Find all active members except the sender
    const members = await db
      .select({ memberDid: conversationMembers.memberDid })
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationDid, conversationDid),
          ne(conversationMembers.memberDid, senderDid),
          isNull(conversationMembers.leftAt),
        ),
      );

    if (members.length === 0) return;

    const isDm = conv?.type === 'dm';
    const title = isDm
      ? `Message from ${senderName}`
      : `${senderName} in ${conv?.name || 'group chat'}`;

    const preview = messagePreview.slice(0, 200);

    await Promise.allSettled(
      members.map((m) =>
        send({
          to: m.memberDid,
          scope: 'chat:message',
          title,
          body: preview,
          data: {
            conversationDid,
            senderDid,
            senderName,
            type: conv?.type || 'unknown',
          },
        }),
      ),
    );
  })().catch((err) => {
    log.error({ err: String(err), conversationDid }, 'Message notification error (non-fatal)');
  });
}
