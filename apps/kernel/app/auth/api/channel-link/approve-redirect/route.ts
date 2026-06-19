import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@imajin/auth';
import { publish } from '@imajin/bus';
import { db, channelLinkTokens, channelLinks } from '@/src/db';
import { and, eq, isNull, gt } from 'drizzle-orm';
import { generateId } from '@/src/lib/kernel/id';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

/**
 * POST /auth/api/channel-link/approve-redirect
 *
 * Form-action handler for the approval page — accepts multipart/form-data
 * or application/x-www-form-urlencoded, then redirects back to the page.
 *
 * The JSON API equivalent is POST /auth/api/channel-link/approve.
 */
export async function POST(request: NextRequest) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.redirect(new URL('/auth?redirect=/auth/settings', request.url));
  }
  const did = authResult.identity.id;

  let tokenValue: string | null = null;
  let returnTo = '/auth/settings';

  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const body = await request.json().catch(() => ({}));
    tokenValue = typeof body.token === 'string' ? body.token : null;
    returnTo = typeof body.returnTo === 'string' ? body.returnTo : returnTo;
  } else {
    const form = await request.formData().catch(() => null);
    tokenValue = form?.get('token')?.toString() ?? null;
    returnTo = form?.get('returnTo')?.toString() ?? returnTo;
  }

  if (!tokenValue) {
    return NextResponse.redirect(new URL(`${returnTo}?error=missing+token`, request.url));
  }

  const [linkToken] = await db
    .select()
    .from(channelLinkTokens)
    .where(
      and(
        eq(channelLinkTokens.token, tokenValue),
        isNull(channelLinkTokens.consumedAt),
        gt(channelLinkTokens.expiresAt, new Date())
      )
    )
    .limit(1);

  if (!linkToken) {
    return NextResponse.redirect(new URL(`${returnTo}?error=link+expired+or+used`, request.url));
  }

  const requestedScopes = (linkToken.requestedScopes as string[]) ?? [];
  const linkId = generateId('cl');

  try {
    await db
      .insert(channelLinks)
      .values({
        id: linkId,
        channel: linkToken.channel,
        channelUid: linkToken.channelUid,
        did,
        appDid: linkToken.appDid,
        scopes: requestedScopes,
        status: 'active',
      })
      .onConflictDoUpdate({
        target: [channelLinks.channel, channelLinks.channelUid, channelLinks.appDid],
        set: { did, scopes: requestedScopes, status: 'active', revokedAt: null },
      });

    await db
      .update(channelLinkTokens)
      .set({ consumedAt: new Date(), consumedBy: did })
      .where(eq(channelLinkTokens.id, linkToken.id));

    publish('channel.link.created', {
      issuer: did,
      subject: linkToken.appDid,
      scope: 'auth',
      payload: { linkId, channel: linkToken.channel, did, appDid: linkToken.appDid, context_id: linkId, context_type: 'channel_link' },
    }).catch((err: unknown) => log.error({ err: String(err) }, 'channel.link.created emit error'));

    log.info({ linkId, channel: linkToken.channel, did }, 'Channel link approved via form');
  } catch (err) {
    log.error({ err: String(err) }, 'Failed to approve channel link');
    return NextResponse.redirect(new URL(`${returnTo}?error=server+error`, request.url));
  }

  return NextResponse.redirect(new URL(returnTo, request.url));
}
