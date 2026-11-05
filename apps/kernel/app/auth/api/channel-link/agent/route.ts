import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { buildPublicUrlAbsolute } from '@imajin/config';
import { db, channelLinkTokens } from '@/src/db';
import { generateId } from '@/src/lib/kernel/id';
import {
  CHANNEL_LINK_HEADERS, channelLinkError, readChannelSender, requireChannelBot,
} from '@/src/lib/auth/channel-speaker';

export async function POST(request: Request) {
  try {
    const { botDid } = await requireChannelBot(request);
    const { channel, channelUid } = await readChannelSender(request);
    const token = randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + 15 * 60_000);
    await db.insert(channelLinkTokens).values({
      id: generateId('clt'), token, channel, channelUid, appDid: botDid,
      // A channel binding, not permission to execute as the sender.
      requestedScopes: ['channel:speaker'], expiresAt,
    });
    return NextResponse.json({
      linkToken: token, url: `${buildPublicUrlAbsolute('kernel')}/auth/channel-link/${token}`,
      expiresAt: expiresAt.toISOString(),
    }, { status: 201, headers: CHANNEL_LINK_HEADERS });
  } catch (error) {
    const failure = channelLinkError(error);
    return NextResponse.json({ error: failure.error }, { status: failure.status, headers: CHANNEL_LINK_HEADERS });
  }
}
