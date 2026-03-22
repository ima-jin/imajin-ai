import { NextRequest } from 'next/server';
import { db, coffeePages, tips } from '@/db';
import { requireAuth } from '@imajin/auth';
import { jsonResponse, errorResponse, generateId } from '@/lib/utils';
import { rateLimit, getClientIP } from '@/lib/rate-limit';

const PAY_SERVICE_URL = process.env.PAY_SERVICE_URL || 'http://localhost:3004';
const COFFEE_URL = process.env.NEXT_PUBLIC_SERVICE_PREFIX 
  ? `${process.env.NEXT_PUBLIC_SERVICE_PREFIX}coffee.${process.env.NEXT_PUBLIC_DOMAIN}`
  : 'https://coffee.imajin.ai';

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
    if (!pageHandle) {
      return errorResponse('pageHandle is required');
    }

    if (!amount || amount < 100) {
      return errorResponse('amount must be at least 100 cents ($1)');
    }

    if (!paymentMethod || !['stripe', 'solana'].includes(paymentMethod)) {
      return errorResponse('paymentMethod must be stripe or solana');
    }

    // Get coffee page
    const page = await db.query.coffeePages.findFirst({
      where: (pages, { eq }) => eq(pages.handle, pageHandle),
    });

    if (!page) {
      return errorResponse('Coffee page not found', 404);
    }

    if (!page.isPublic) {
      return errorResponse('This page is not accepting tips', 403);
    }

    // Check if payment method is enabled
    const methods = page.paymentMethods as any;
    if (paymentMethod === 'stripe' && !methods?.stripe?.enabled) {
      return errorResponse('Card payments not enabled for this page');
    }
    if (paymentMethod === 'solana' && !methods?.solana?.enabled) {
      return errorResponse('Solana payments not enabled for this page');
    }

    // Check message permission
    if (message && !page.allowMessages) {
      return errorResponse('This page does not accept messages with tips');
    }

    // Get sender identity if authenticated
    let fromDid: string | null = null;
    const authResult = await requireAuth(request as any);
    if ('identity' in authResult) {
      fromDid = authResult.identity.id;
    }

    // Create tip record (pending)
    const tipId = generateId('tip');

    if (paymentMethod === 'stripe') {
      // Use Stripe Checkout (redirect flow) via pay service
      const payRes = await fetch(`${PAY_SERVICE_URL}/api/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [{
            name: `Tip for ${page.title || page.handle}`,
            description: message ? `"${message}" — ${fromName || 'Anonymous'}` : `From ${fromName || 'Anonymous'}`,
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
        console.error('Pay service checkout failed:', err);
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

      // Return checkout URL for redirect
      return jsonResponse({
        tipId,
        url: payData.url,
        paymentMethod: 'stripe',
      });
    }

    if (paymentMethod === 'solana') {
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

      return jsonResponse({
        tipId,
        solanaAddress,
        amount,
        paymentMethod: 'solana',
      });
    }

    return errorResponse('Invalid payment method');
  } catch (error) {
    console.error('Failed to create tip:', error);
    return errorResponse('Failed to process tip', 500);
  }
}
