import { NextResponse, type NextRequest } from 'next/server';
import { createLogger } from '@imajin/logger';
import {
  resolveConnectionsByGmailAddress,
  readStoredHistoryId,
  advanceHistoryId,
  processHistorySince,
} from '@/src/lib/google/gmail';
import { withConnectorConnection } from '@/src/lib/kernel/connector-connection-context';
import { forEachSequential } from '@/src/lib/async/sequential';

const log = createLogger('kernel');

/** This route reads live DB state per invocation and must never be statically prerendered. */
export const dynamic = 'force-dynamic';

/** Pub/Sub push envelope (https://cloud.google.com/pubsub/docs/push). */
interface PubSubPushBody {
  message?: {
    data?: string;
    messageId?: string;
    publishTime?: string;
  };
  subscription?: string;
}

/** The Gmail `users.watch` push notification payload, base64-encoded in `message.data`. */
interface GmailPushNotification {
  emailAddress?: string;
  historyId?: number | string;
}

/**
 * POST /google/api/webhook/gmail — Gmail push notification receiver (#2144).
 *
 * Google's Pub/Sub push subscription is configured (outside this repo — see
 * `docs/guide/google-workspace-connector.md`) with a shared-secret query
 * token appended to this URL, e.g. `?token=...`, checked against
 * `GOOGLE_GMAIL_PUBSUB_PUSH_TOKEN`. This is the pragmatic verification
 * mechanism Pub/Sub push explicitly supports as an alternative to OIDC
 * token verification, and is what every other webhook route in this repo
 * (Stripe, QuickBooks, Intuit) does the equivalent of with its own provider's
 * signature/token scheme.
 *
 * Always answers 200/204 once the push is authenticated, even when the
 * referenced mailbox is unknown or processing fails internally — Pub/Sub
 * retries (and eventually dead-letters) a push that does not get a 2xx, and
 * an unknown mailbox is not something retrying will ever fix.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const expectedToken = process.env.GOOGLE_GMAIL_PUBSUB_PUSH_TOKEN;
  if (expectedToken) {
    const { searchParams } = new URL(request.url);
    if (searchParams.get('token') !== expectedToken) {
      return NextResponse.json({ error: 'invalid push token' }, { status: 401 });
    }
  }

  let body: PubSubPushBody;
  try {
    body = (await request.json()) as PubSubPushBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const rawData = body.message?.data;
  if (!rawData) {
    // Malformed push — nothing to retry into correctness. Ack it anyway.
    return new NextResponse(null, { status: 204 });
  }

  let notification: GmailPushNotification;
  try {
    notification = JSON.parse(Buffer.from(rawData, 'base64').toString('utf-8')) as GmailPushNotification;
  } catch (err) {
    log.warn({ err: String(err) }, 'gmail webhook: failed to decode push payload');
    return new NextResponse(null, { status: 204 });
  }

  const { emailAddress, historyId } = notification;
  if (!emailAddress || historyId === undefined) {
    return new NextResponse(null, { status: 204 });
  }

  const connections = await resolveConnectionsByGmailAddress(emailAddress);
  if (!connections.length) {
    log.warn({ emailAddress }, 'gmail webhook: no owner registered for this mailbox — dropping push');
    return new NextResponse(null, { status: 204 });
  }

  await forEachSequential(connections, ({ ownerDid, slot }) =>
    withConnectorConnection('google', ownerDid, slot, async () => {
      try {
        const startHistoryId = (await readStoredHistoryId(ownerDid, slot)) ?? String(historyId);
        const latestHistoryId = await processHistorySince(ownerDid, startHistoryId);
        await advanceHistoryId(ownerDid, latestHistoryId, slot);
      } catch {
        log.error({ ownerDid, slot }, 'gmail webhook: history processing failed');
      }
    }),
  );

  return new NextResponse(null, { status: 204 });
}
