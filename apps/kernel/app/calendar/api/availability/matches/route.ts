import { NextResponse } from 'next/server';
import { requireAppAuth } from '@imajin/auth';
import { db, matchNotifications, channelLinks } from '@/src/db';
import { and, eq, isNull, inArray } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

/**
 * GET /calendar/api/availability/matches (bot-authenticated)
 *
 * Returns pending match notifications for users linked to the requesting bot.
 * The bot polls this to know who to notify and what to say.
 *
 * For each notification, also returns the channelUid so the bot knows
 * which Telegram chat to deliver to.
 *
 * Response: { notifications: [{ id, matchId, recipientDid, channelUid, otherDid,
 *             overlapTags, isSensitive, deliveryPolicy, createdAt }] }
 */
export async function GET(request: Request) {
  const appResult = await requireAppAuth(request);
  if ('error' in appResult) {
    return NextResponse.json({ error: appResult.error }, { status: appResult.status });
  }
  const { appDid } = appResult.appAuth;

  // Find all DIDs linked to this bot.
  const linkedDids = await db
    .select({ did: channelLinks.did, channelUid: channelLinks.channelUid, channel: channelLinks.channel })
    .from(channelLinks)
    .where(and(eq(channelLinks.appDid, appDid), eq(channelLinks.status, 'active')));

  if (linkedDids.length === 0) {
    return NextResponse.json({ notifications: [] });
  }

  const didList = linkedDids.map((l) => l.did);
  const channelByDid = new Map(linkedDids.map((l) => [l.did, { channelUid: l.channelUid, channel: l.channel }]));

  // Fetch pending notifications for those DIDs.
  const pending = await db
    .select()
    .from(matchNotifications)
    .where(and(inArray(matchNotifications.recipientDid, didList), isNull(matchNotifications.deliveredAt)));

  const notifications = pending.map((n) => ({
    id: n.id,
    matchId: n.matchId,
    recipientDid: n.recipientDid,
    channel: channelByDid.get(n.recipientDid)?.channel ?? 'telegram',
    channelUid: channelByDid.get(n.recipientDid)?.channelUid ?? null,
    otherDid: n.otherDid,
    overlapTags: n.overlapTags,
    isSensitive: n.isSensitive,
    deliveryPolicy: n.deliveryPolicy,
    createdAt: n.createdAt,
  }));

  return NextResponse.json({ notifications });
}

/**
 * PATCH /calendar/api/availability/matches (bot-authenticated)
 *
 * Mark notifications as delivered. Called by the bot after sending to chat.
 * Body: { ids: string[] }
 */
export async function PATCH(request: Request) {
  const appResult = await requireAppAuth(request);
  if ('error' in appResult) {
    return NextResponse.json({ error: appResult.error }, { status: appResult.status });
  }
  const { appDid } = appResult.appAuth;

  let body: { ids?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const ids = Array.isArray(body.ids) ? (body.ids as string[]).filter((id) => typeof id === 'string') : [];
  if (ids.length === 0) {
    return NextResponse.json({ error: 'ids is required' }, { status: 400 });
  }

  // Verify these notifications belong to users linked to this bot.
  const linkedDids = await db
    .select({ did: channelLinks.did })
    .from(channelLinks)
    .where(and(eq(channelLinks.appDid, appDid), eq(channelLinks.status, 'active')));

  const didSet = new Set(linkedDids.map((l) => l.did));

  const toMark = await db
    .select({ id: matchNotifications.id, recipientDid: matchNotifications.recipientDid })
    .from(matchNotifications)
    .where(inArray(matchNotifications.id, ids));

  const authorizedIds = toMark.filter((n) => didSet.has(n.recipientDid)).map((n) => n.id);
  if (authorizedIds.length === 0) {
    return NextResponse.json({ marked: 0 });
  }

  await db
    .update(matchNotifications)
    .set({ deliveredAt: new Date() })
    .where(inArray(matchNotifications.id, authorizedIds));

  log.info({ appDid, count: authorizedIds.length }, 'Match notifications marked as delivered');

  return NextResponse.json({ marked: authorizedIds.length });
}
