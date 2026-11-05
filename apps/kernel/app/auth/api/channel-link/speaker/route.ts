import { NextResponse } from 'next/server';
import {
  CHANNEL_LINK_HEADERS, channelLinkError, readChannelSender, requireChannelBot, resolveChannelSpeaker,
} from '@/src/lib/auth/channel-speaker';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const { botDid, orgDid } = await requireChannelBot(request);
    const { channel, channelUid } = await readChannelSender(request);
    return NextResponse.json(await resolveChannelSpeaker(botDid, orgDid, channel, channelUid), {
      headers: CHANNEL_LINK_HEADERS,
    });
  } catch (error) {
    const failure = channelLinkError(error);
    return NextResponse.json({ error: failure.error }, { status: failure.status, headers: CHANNEL_LINK_HEADERS });
  }
}
