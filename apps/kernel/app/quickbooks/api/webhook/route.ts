/**
 * POST /quickbooks/api/webhook (xprize #35)
 *
 * Intuit's push notification for QuickBooks Online data-change events. No
 * imajin session — Intuit calls this endpoint directly, the same no-session
 * shape as the OAuth callback route. Intuit requires a 200 within 2 seconds,
 * so verification happens inline but settlement runs in the background via
 * `after()` once the response has already been sent.
 *
 * Flow:
 *   1. Read the raw body (the HMAC is computed over the exact bytes) and the
 *      `intuit-signature` header.
 *   2. Parse the body far enough to read the first `realmId`, then resolve it
 *      through the realmId -> { ownerDid, appDid } index (#35) to find which
 *      app's sealed config owns the webhook verifier token for this delivery.
 *      A single delivery's `eventNotifications` are all signed with one app's
 *      verifier token (Intuit webhooks are registered per app, not per realm).
 *   3. Verify the signature against that app's `webhookVerifierToken`. Any
 *      failure here — missing header, unknown realm, missing verifier token,
 *      bad signature — is rejected before anything is trusted.
 *   4. Once verified, settle every distinct realm named in the payload in the
 *      background: resolve its ownerDid + appDid and call
 *      `settlePaidInvoices(ownerDid, appDid)`.
 */
import { NextResponse, after, type NextRequest } from 'next/server';
import { createLogger } from '@imajin/logger';
import { loadConfig } from '@/src/lib/quickbooks/connector';
import { resolveRealmOwner } from '@/src/lib/quickbooks/realm-index';
import { verifyIntuitWebhookSignature } from '@/src/lib/quickbooks/webhook-verify';
import { settlePaidInvoices } from '@/src/lib/quickbooks/settlement';

const log = createLogger('kernel');

/** This route reads a signature header and a raw body per request — never statically prerender it. */
export const dynamic = 'force-dynamic';

interface QuickBooksWebhookEntity {
  name: string;
  id: string;
  operation: string;
}

interface QuickBooksWebhookEventNotification {
  realmId: string;
  dataChangeEvent?: { entities?: QuickBooksWebhookEntity[] };
}

interface QuickBooksWebhookPayload {
  eventNotifications?: QuickBooksWebhookEventNotification[];
}

/** Parse the webhook body just enough to read the realmIds; null on malformed JSON. */
function parsePayload(rawBody: string): QuickBooksWebhookPayload | null {
  try {
    return JSON.parse(rawBody) as QuickBooksWebhookPayload;
  } catch {
    return null;
  }
}

/** Distinct, non-empty realmIds named anywhere in the payload, in first-seen order. */
function distinctRealmIds(payload: Readonly<QuickBooksWebhookPayload>): string[] {
  const seen = new Set<string>();
  for (const notification of payload.eventNotifications ?? []) {
    if (notification.realmId) seen.add(notification.realmId);
  }
  return [...seen];
}

/**
 * Settle every distinct realm named in a verified webhook payload. Runs after
 * the response is sent (see `after()` below) — Intuit does not wait for this.
 */
async function settleWebhookPayload(payload: Readonly<QuickBooksWebhookPayload>): Promise<void> {
  for (const realmId of distinctRealmIds(payload)) {
    const owner = await resolveRealmOwner(realmId);
    if (!owner) {
      log.warn({ realmId }, 'QuickBooks webhook: settle skipped — realmId not indexed');
      continue;
    }
    try {
      const result = await settlePaidInvoices(owner.ownerDid, owner.appDid);
      log.info(
        { realmId, ownerDid: owner.ownerDid, settled: result.settled.length, skipped: result.skipped.length },
        'QuickBooks webhook: settlement run complete',
      );
    } catch (err) {
      log.error({ err: String(err), realmId, ownerDid: owner.ownerDid }, 'QuickBooks webhook: settlement run failed');
    }
  }
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const signature = request.headers.get('intuit-signature');
  if (!signature) {
    return NextResponse.json({ error: 'Missing intuit-signature header' }, { status: 400 });
  }

  const payload = parsePayload(rawBody);
  if (!payload) {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const realmIds = distinctRealmIds(payload);
  const firstRealmId = realmIds[0];
  if (!firstRealmId) {
    return NextResponse.json({ error: 'No eventNotifications with a realmId' }, { status: 400 });
  }

  // A delivery's eventNotifications are all signed with one app's verifier
  // token, so resolving the first realmId is enough to find it (#35).
  const owner = await resolveRealmOwner(firstRealmId);
  if (!owner) {
    log.warn({ realmId: firstRealmId }, 'QuickBooks webhook: rejected — realmId not indexed');
    return NextResponse.json({ error: 'Unknown realmId' }, { status: 400 });
  }

  let verifierToken: string | undefined;
  try {
    const config = await loadConfig(owner.appDid);
    verifierToken = config.webhookVerifierToken;
  } catch (err) {
    log.error({ err: String(err), appDid: owner.appDid }, 'QuickBooks webhook: failed to load app config');
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 500 });
  }
  if (!verifierToken) {
    log.error({ appDid: owner.appDid }, 'QuickBooks webhook: no webhookVerifierToken sealed for app');
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 500 });
  }

  if (!verifyIntuitWebhookSignature(rawBody, signature, verifierToken)) {
    log.warn({ appDid: owner.appDid }, 'QuickBooks webhook: signature verification failed');
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  // Respond within Intuit's 2s window; settle in the background.
  after(() => settleWebhookPayload(payload));

  return NextResponse.json({ received: true });
}
