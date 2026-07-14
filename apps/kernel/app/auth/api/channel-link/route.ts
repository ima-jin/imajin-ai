import { NextResponse } from 'next/server';
import { requireAuth, requireAppAuth } from '@imajin/auth';
import { db, channelLinkTokens, channelLinks, registryApps } from '@/src/db';
import { eq, desc } from 'drizzle-orm';
import { generateId } from '@/src/lib/kernel/id';
import { randomBytes } from 'node:crypto';
import { createLogger } from '@imajin/logger';
import { buildPublicUrlAbsolute } from '@imajin/config';

const log = createLogger('kernel');

const VALID_CHANNELS = ['telegram', 'whatsapp', 'signal'] as const;
const TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes

/**
 * POST /auth/api/channel-link (bot-authenticated)
 *
 * Bot calls this to start the linking flow for a chat user.
 * Returns a one-time URL the bot sends to the user in chat.
 *
 * Body: { channel, channelUid, requestedScopes? }
 * Response: { linkToken, url, expiresAt }
 */
export async function POST(request: Request) {
  const appResult = await requireAppAuth(request);
  if ('error' in appResult) {
    return NextResponse.json({ error: appResult.error }, { status: appResult.status });
  }
  const { appDid } = appResult.appAuth;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const channel = typeof body.channel === 'string' ? body.channel : null;
  if (!channel || !VALID_CHANNELS.includes(channel as typeof VALID_CHANNELS[number])) {
    return NextResponse.json({ error: `channel must be one of: ${VALID_CHANNELS.join(', ')}` }, { status: 400 });
  }

  const channelUid = typeof body.channelUid === 'string' ? body.channelUid.trim() : null;
  if (!channelUid) {
    return NextResponse.json({ error: 'channelUid is required' }, { status: 400 });
  }

  const requestedScopes: string[] = Array.isArray(body.requestedScopes)
    ? (body.requestedScopes as string[]).filter((s) => typeof s === 'string')
    : ['availability:read', 'availability:write'];

  const token = randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
  const id = generateId('clt');

  try {
    await db.insert(channelLinkTokens).values({
      id,
      token,
      channel,
      channelUid,
      appDid,
      requestedScopes,
      expiresAt,
    });
  } catch (err) {
    log.error({ err: String(err) }, 'Failed to create channel link token');
    return NextResponse.json({ error: 'Failed to create link token' }, { status: 500 });
  }

  const baseUrl = buildPublicUrlAbsolute('kernel');
  const url = `${baseUrl}/auth/channel-link/${token}`;

  log.info({ id, channel, channelUid, appDid }, 'Channel link token created');

  return NextResponse.json({ linkToken: token, url, expiresAt: expiresAt.toISOString() }, { status: 201 });
}

/**
 * GET /auth/api/channel-link (user-authenticated)
 *
 * List the authenticated user's active channel links.
 * Feeds the disclosure dashboard (#1053).
 */
export async function GET(request: Request) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }
  const did = authResult.identity.actingFor ?? authResult.identity.actingAs ?? authResult.identity.id;

  const links = await db
    .select({
      id: channelLinks.id,
      channel: channelLinks.channel,
      channelUid: channelLinks.channelUid,
      appDid: channelLinks.appDid,
      scopes: channelLinks.scopes,
      status: channelLinks.status,
      createdAt: channelLinks.createdAt,
      revokedAt: channelLinks.revokedAt,
      appName: registryApps.name,
    })
    .from(channelLinks)
    .leftJoin(registryApps, eq(registryApps.appDid, channelLinks.appDid))
    .where(eq(channelLinks.did, did))
    .orderBy(desc(channelLinks.createdAt));

  return NextResponse.json({ links });
}
