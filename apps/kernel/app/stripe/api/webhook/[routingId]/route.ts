/**
 * POST /stripe/api/webhook/[routingId] (#1785)
 *
 * Stripe's push delivery for a BYO-key connector owner's events. No imajin
 * session — Stripe calls this endpoint directly, the same no-session shape
 * as the QuickBooks webhook route. `routingId` is the opaque id minted at
 * connect time and embedded in the URL registered with Stripe
 * (`connector.ts` / `webhook-index.ts`) — it is what lets this single route
 * serve every owner's endpoint and still resolve which owner's signing
 * secret to verify against.
 *
 * All verification (routing lookup, signing-secret load, HMAC + replay
 * check) happens in `handleVerifiedWebhookEvent`; this route only translates
 * its result into an HTTP response. Every rejection is a 4xx so Stripe does
 * not retry a delivery this node will never accept.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createLogger } from '@imajin/logger';
import { handleVerifiedWebhookEvent } from '@/src/lib/stripe/connector';

const log = createLogger('kernel');

/** This route reads a signature header and a raw body per request — never statically prerender it. */
export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ routingId: string }> },
): Promise<NextResponse> {
  const { routingId } = await params;
  const rawBody = await request.text();
  const signature = request.headers.get('stripe-signature');

  const result = await handleVerifiedWebhookEvent(routingId, rawBody, signature);

  switch (result.status) {
    case 'ok':
      return NextResponse.json({ received: true, published: result.published });
    case 'unknown_routing':
      log.warn({ routingId }, 'Stripe webhook: rejected — unknown routing id');
      return NextResponse.json({ error: 'Unknown webhook endpoint' }, { status: 404 });
    case 'invalid_signature':
      log.warn({ routingId, reason: result.reason }, 'Stripe webhook: signature verification failed');
      return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
    case 'malformed_payload':
      log.warn({ routingId }, 'Stripe webhook: malformed JSON payload');
      return NextResponse.json({ error: 'Malformed payload' }, { status: 400 });
  }
}
