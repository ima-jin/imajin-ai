import { NextRequest } from 'next/server';
import { createLogger } from '@imajin/logger';
const log = createLogger('coffee');
import { db, tips } from '@/db';
import { requireAuth , resolveActingDid } from '@imajin/auth';
import * as bus from '@imajin/bus';
import { jsonResponse, errorResponse, generateId } from '@/lib/utils';
import { rateLimit, getClientIP, buildPublicUrl } from '@imajin/config';

const PAY_SERVICE_URL = process.env.PAY_SERVICE_URL || 'http://localhost:3004';

const COFFEE_URL = buildPublicUrl('coffee');

/** Loosely-typed coffee page record as read from the database */
type CoffeePageRecord = any;

/** Validate the basic shape of a tip request body. Returns an error message, or null when valid. */
function validateTipRequestBody(body: any): string | null {
  const { pageHandle, amount, paymentMethod } = body;

  if (!pageHandle) {
    return 'pageHandle is required';
  }

  if (!amount || amount < 100) {
    return 'amount must be at least 100 cents ($1)';
  }

  if (!paymentMethod || !['stripe', 'solana'].includes(paymentMethod)) {
    return 'paymentMethod must be stripe or solana';
  }

  return null;
}

/** Validate that a coffee page can accept this tip request (visibility, payment method, messages) */
function validatePageForTip(
  page: CoffeePageRecord,
  paymentMethod: string,
  message: string | undefined
): { message: string; status?: number } | null {
  if (!page.isPublic) {
    return { message: 'This page is not accepting tips', status: 403 };
  }

  // Check if payment method is enabled
  const methods = page.paymentMethods;
  if (paymentMethod === 'stripe' && !methods?.stripe?.enabled) {
    return { message: 'Card payments not enabled for this page' };
  }
  if (paymentMethod === 'solana' && !methods?.solana?.enabled) {
    return { message: 'Solana payments not enabled for this page' };
  }

  // Check message permission
  if (message && !page.allowMessages) {
    return { message: 'This page does not accept messages with tips' };
  }

  return null;
}

/** Resolve the sender's identity from the request, if authenticated */
async function resolveSender(request: NextRequest): Promise<{ fromDid: string | null; fromHumanDid: string | null }> {
  let fromDid: string | null = null;
  let fromHumanDid: string | null = null;
  const authResult = await requireAuth(request as any);
  if ('identity' in authResult) {
    fromDid = resolveActingDid(authResult.identity);
    fromHumanDid = authResult.identity.id;
  }
  return { fromDid, fromHumanDid };
}

/** Create a pending tip and start a Stripe Checkout session for it */
async function createStripeTip(params: {
  tipId: string;
  page: CoffeePageRecord;
  amount: number;
  currency: string;
  message: string | undefined;
  fromName: string | undefined;
  fromDid: string | null;
  fromHumanDid: string | null;
  fundDirection: string | undefined;
  recurring: boolean | undefined;
  pageHandle: string;
}) {
  const { tipId, page, amount, currency, message, fromName, fromDid, fromHumanDid, fundDirection, recurring, pageHandle } = params;

  // Use Stripe Checkout (redirect flow) via pay service
  const payRes = await fetch(`${PAY_SERVICE_URL}/api/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sellerDid: page.did,
      items: [{
        name: `Tip for ${page.title || page.handle}`,
        description: message ? `"${message}" â€” ${fromName || 'Anonymous'}` : `From ${fromName || 'Anonymous'}`,
        amount,
        quantity: 1,
      }],
      currency: currency.toUpperCase(),
      mode: recurring ? 'subscription' : 'payment',
      successUrl: `${COFFEE_URL}/success?handle=${pageHandle}${recurring ? '&type=subscription' : ''}`,
      cancelUrl: `${COFFEE_URL}/${pageHandle}`,
      metadata: {
        service: 'coffee',
        type: 'tip',
        tipId,
        pageId: page.id,
        pageHandle: page.handle,
        to_did: page.did,
        fromDid: fromDid || 'anonymous',
        fromName: fromName || 'Anonymous',
        message: message || '',
        ...(fundDirection ? { fundDirection } : {}),
      },
    }),
  });

  if (!payRes.ok) {
    const err = await payRes.text();
    log.error({ err }, 'Pay service checkout failed');
    return errorResponse('Failed to create payment', 500);
  }

  const payData = await payRes.json();

  // Insert pending tip
  await db.insert(tips).values({
    id: tipId,
    pageId: page.id,
    fromDid,
    fromName: fromName || null,
    amount,
    currency,
    message: message || null,
    paymentMethod: 'stripe',
    paymentId: payData.id,
    status: 'pending',
  });

  // Fire and forget â€” never block the response
  if (fromDid) {
    bus.publish('tip.granted', {
      issuer: fromHumanDid!, subject: page.did, scope: 'coffee',
      payload: { amount, currency, context_id: tipId, context_type: 'coffee' }
    });
  }

  // Return checkout URL for redirect
  return jsonResponse({
    tipId,
    url: payData.url,
    paymentMethod: 'stripe',
  });
}

/** Create a pending tip to be settled via a direct Solana transfer */
async function createSolanaTip(params: {
  tipId: string;
  page: CoffeePageRecord;
  amount: number;
  fromName: string | undefined;
  fromDid: string | null;
  fromHumanDid: string | null;
  message: string | undefined;
}) {
  const { tipId, page, amount, fromName, fromDid, fromHumanDid, message } = params;
  const methods = page.paymentMethods;
  // For Solana, return the destination address
  const solanaAddress = methods.solana.address;

  await db.insert(tips).values({
    id: tipId,
    pageId: page.id,
    fromDid,
    fromName: fromName || null,
    amount,
    currency: 'SOL',
    message: message || null,
    paymentMethod: 'solana',
    paymentId: 'pending',
    status: 'pending',
  });

  // Fire and forget â€” never block the response
  if (fromDid) {
    bus.publish('tip.granted', {
      issuer: fromHumanDid!, subject: page.did, scope: 'coffee',
      payload: { amount, currency: 'SOL', context_id: tipId, context_type: 'coffee' }
    });
  }

  return jsonResponse({
    tipId,
    solanaAddress,
    amount,
    paymentMethod: 'solana',
  });
}

/**
 * POST /api/tip - Send a tip via Stripe Checkout
 *
 * Body:
 * - pageHandle: string (required)
 * - amount: number in cents (required)
 * - currency: string (default: 'USD')
 * - paymentMethod: 'stripe' | 'solana' (required)
 * - message?: string
 * - fromName?: string (for anonymous tips)
 * - fundDirection?: string
 * - recurring?: boolean
 */
export async function POST(request: NextRequest) {
  const ip = getClientIP(request);
  const rl = rateLimit(ip, 10, 60_000);
  if (rl.limited) {
    return errorResponse(`Too many requests. Retry after ${rl.retryAfter}s`, 429);
  }

  try {
    const body = await request.json();
    const { pageHandle, amount, currency = 'USD', paymentMethod, message, fromName, fundDirection, recurring } = body;

    // Validate required fields
    const validationError = validateTipRequestBody(body);
    if (validationError) {
      return errorResponse(validationError);
    }

    // Get coffee page
    const page = await db.query.coffeePages.findFirst({
      where: (pages, { eq }) => eq(pages.handle, pageHandle),
    });

    if (!page) {
      return errorResponse('Coffee page not found', 404);
    }

    const pageError = validatePageForTip(page, paymentMethod, message);
    if (pageError) {
      return errorResponse(pageError.message, pageError.status);
    }

    // Get sender identity if authenticated
    const { fromDid, fromHumanDid } = await resolveSender(request);

    // Create tip record (pending)
    const tipId = generateId('tip');

    if (paymentMethod === 'stripe') {
      return createStripeTip({ tipId, page, amount, currency, message, fromName, fromDid, fromHumanDid, fundDirection, recurring, pageHandle });
    }

    if (paymentMethod === 'solana') {
      return createSolanaTip({ tipId, page, amount, fromName, fromDid, fromHumanDid, message });
    }

    return errorResponse('Invalid payment method');
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to create tip');
    return errorResponse('Failed to process tip', 500);
  }
}
