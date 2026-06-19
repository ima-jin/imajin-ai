import { NextResponse } from 'next/server';
import { requireAppAuth } from '@imajin/auth';
import { db, channelLinks } from '@/src/db';
import { and, eq } from 'drizzle-orm';

/**
 * GET /auth/api/channel-link/resolve?channel=telegram&channelUid=<id>
 * (bot-authenticated)
 *
 * Resolves a channel account to an Imajin DID + approved scopes.
 * This is the call the bot makes on every inbound message to get the userDid
 * for actingFor delegation.
 *
 * The appDid is taken from the bot's own auth token — bots can only resolve
 * links they own (they can't look up another bot's users).
 *
 * Response: { did, scopes } or 404 if no active link exists.
 */
export async function GET(request: Request) {
  const appResult = await requireAppAuth(request);
  if ('error' in appResult) {
    return NextResponse.json({ error: appResult.error }, { status: appResult.status });
  }
  const { appDid } = appResult.appAuth;

  const url = new URL(request.url);
  const channel = url.searchParams.get('channel');
  const channelUid = url.searchParams.get('channelUid');

  if (!channel || !channelUid) {
    return NextResponse.json({ error: 'channel and channelUid query params are required' }, { status: 400 });
  }

  const [link] = await db
    .select({ did: channelLinks.did, scopes: channelLinks.scopes })
    .from(channelLinks)
    .where(
      and(
        eq(channelLinks.channel, channel),
        eq(channelLinks.channelUid, channelUid),
        eq(channelLinks.appDid, appDid),
        eq(channelLinks.status, 'active')
      )
    )
    .limit(1);

  if (!link) {
    return NextResponse.json({ error: 'No active channel link found' }, { status: 404 });
  }

  return NextResponse.json({ did: link.did, scopes: link.scopes });
}
