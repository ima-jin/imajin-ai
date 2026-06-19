import { NextResponse } from 'next/server';
import { requireAuth } from '@imajin/auth';
import { publish } from '@imajin/bus';
import { db, channelLinkTokens, channelLinks } from '@/src/db';
import { and, eq, isNull, gt } from 'drizzle-orm';
import { generateId } from '@/src/lib/kernel/id';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

/**
 * POST /auth/api/channel-link/approve (user-authenticated)
 *
 * User approves the linking request. Validates the challenge token,
 * writes the persistent channel ↔ DID binding, marks the token consumed.
 *
 * Body: { token, scopes? }
 * - token: the linkToken from the start response
 * - scopes: approved subset of requestedScopes (defaults to all requestedScopes)
 *
 * Response: { linkId, channel, channelUid, appDid, scopes }
 */
export async function POST(request: Request) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }
  const did = authResult.identity.id; // always the actual user's DID — not delegated

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const tokenValue = typeof body.token === 'string' ? body.token.trim() : null;
  if (!tokenValue) {
    return NextResponse.json({ error: 'token is required' }, { status: 400 });
  }

  // Look up the challenge token — must exist, not expired, not consumed.
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
    return NextResponse.json(
      { error: 'Link token is invalid, expired, or already used' },
      { status: 400 }
    );
  }

  // Validate requested scopes.
  const requestedScopes = (linkToken.requestedScopes as string[]) ?? [];
  const approvedScopes: string[] = Array.isArray(body.scopes)
    ? (body.scopes as string[]).filter(
        (s) => typeof s === 'string' && requestedScopes.includes(s)
      )
    : requestedScopes;

  if (approvedScopes.length === 0) {
    return NextResponse.json({ error: 'No valid scopes approved' }, { status: 400 });
  }

  const linkId = generateId('cl');

  // Write the binding. ON CONFLICT: re-activate a previously revoked link or update scopes.
  await db
    .insert(channelLinks)
    .values({
      id: linkId,
      channel: linkToken.channel,
      channelUid: linkToken.channelUid,
      did,
      appDid: linkToken.appDid,
      scopes: approvedScopes,
      status: 'active',
    })
    .onConflictDoUpdate({
      target: [channelLinks.channel, channelLinks.channelUid, channelLinks.appDid],
      set: {
        did,
        scopes: approvedScopes,
        status: 'active',
        revokedAt: null,
      },
    });

  // Mark token consumed (single-use enforcement).
  await db
    .update(channelLinkTokens)
    .set({ consumedAt: new Date(), consumedBy: did })
    .where(eq(channelLinkTokens.id, linkToken.id));

  // Fire-and-forget bus event.
  publish('channel.link.created', {
    issuer: did,
    subject: linkToken.appDid,
    scope: 'auth',
    payload: {
      linkId,
      channel: linkToken.channel,
      did,
      appDid: linkToken.appDid,
      context_id: linkId,
      context_type: 'channel_link',
    },
  }).catch((err: unknown) => log.error({ err: String(err) }, 'channel.link.created emit error'));

  log.info({ linkId, channel: linkToken.channel, did, appDid: linkToken.appDid }, 'Channel link approved');

  return NextResponse.json({
    linkId,
    channel: linkToken.channel,
    channelUid: linkToken.channelUid,
    appDid: linkToken.appDid,
    scopes: approvedScopes,
  }, { status: 201 });
}
