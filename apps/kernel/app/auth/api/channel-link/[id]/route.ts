import { NextResponse } from 'next/server';
import { requireAuth, requireAppAuth } from '@imajin/auth';
import { publish } from '@imajin/bus';
import { db, channelLinks } from '@/src/db';
import { eq } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

/**
 * DELETE /auth/api/channel-link/:id
 *
 * Revoke a channel link. Callable by either:
 * - The linked user (session auth) — can revoke their own links
 * - The bot that owns the link (app auth) — can revoke links for their app
 *
 * Revocation is immediate. Subsequent resolve calls return 404.
 */
export async function DELETE(
  request: Request,
  { params }: { params: { id: string } }
) {
  const { id } = params;

  // Determine caller identity (user or bot).
  let callerDid: string | null = null;
  let callerAppDid: string | null = null;

  const appResult = await requireAppAuth(request);
  if (!('error' in appResult)) {
    callerAppDid = appResult.appAuth.appDid;
  } else {
    const authResult = await requireAuth(request);
    if ('error' in authResult) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }
    callerDid = authResult.identity.id;
  }

  // Look up the link.
  const [link] = await db
    .select()
    .from(channelLinks)
    .where(eq(channelLinks.id, id))
    .limit(1);

  if (!link) {
    return NextResponse.json({ error: 'Link not found' }, { status: 404 });
  }

  // Authorization: must be the linked user or the owning bot.
  const isOwner = callerDid === link.did;
  const isBot = callerAppDid === link.appDid;

  if (!isOwner && !isBot) {
    return NextResponse.json({ error: 'Forbidden — not authorized to revoke this link' }, { status: 403 });
  }

  if (link.status === 'revoked') {
    return NextResponse.json({ error: 'Link is already revoked' }, { status: 400 });
  }

  // Revoke.
  await db
    .update(channelLinks)
    .set({ status: 'revoked', revokedAt: new Date() })
    .where(eq(channelLinks.id, id));

  // Fire-and-forget bus event.
  publish('channel.link.revoked', {
    issuer: callerDid ?? callerAppDid ?? 'unknown',
    subject: link.did,
    scope: 'auth',
    payload: {
      linkId: id,
      channel: link.channel,
      did: link.did,
      appDid: link.appDid,
      context_id: id,
      context_type: 'channel_link',
    },
  }).catch((err: unknown) => log.error({ err: String(err) }, 'channel.link.revoked emit error'));

  log.info({ linkId: id, channel: link.channel, did: link.did }, 'Channel link revoked');

  return NextResponse.json({ revoked: true });
}
