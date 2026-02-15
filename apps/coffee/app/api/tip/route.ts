import { NextRequest } from 'next/server';
import { db, coffeePages, tips } from '@/db';
import { extractToken, validateToken } from '@/lib/auth';
import { jsonResponse, errorResponse, generateId } from '@/lib/utils';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2023-10-16',
});

/**
 * POST /api/tip - Send a tip
 * 
 * Body:
 * - pageHandle: string (required)
 * - amount: number in cents (required)
 * - currency: string (default: 'USD')
 * - paymentMethod: 'stripe' | 'solana' (required)
 * - message?: string
 * - fromName?: string (for anonymous tips)
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { pageHandle, amount, currency = 'USD', paymentMethod, message, fromName } = body;

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
    const token = extractToken(request);
    if (token) {
      const authResult = await validateToken(token);
      if (authResult.valid && authResult.identity) {
        fromDid = authResult.identity.id;
      }
    }

    // Create tip record (pending)
    const tipId = generateId('tip');

    if (paymentMethod === 'stripe') {
      // Create Stripe Payment Intent
      const stripeAccountId = methods.stripe.accountId;
      
      const paymentIntent = await stripe.paymentIntents.create({
        amount,
        currency: currency.toLowerCase(),
        automatic_payment_methods: { enabled: true },
        metadata: {
          tipId,
          pageId: page.id,
          pageHandle: page.handle,
          fromDid: fromDid || 'anonymous',
          fromName: fromName || 'Anonymous',
          message: message || '',
        },
        // Transfer to connected account (minus platform fee if any)
        transfer_data: stripeAccountId ? {
          destination: stripeAccountId,
        } : undefined,
      });

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
        paymentId: paymentIntent.id,
        status: 'pending',
      });

      return jsonResponse({
        tipId,
        clientSecret: paymentIntent.client_secret,
        paymentMethod: 'stripe',
      });
    } 
    
    if (paymentMethod === 'solana') {
      // For Solana, return the destination address
      // Client will build and sign the transaction
      const solanaAddress = methods.solana.address;

      // Insert pending tip (will be confirmed via webhook or polling)
      await db.insert(tips).values({
        id: tipId,
        pageId: page.id,
        fromDid,
        fromName: fromName || null,
        amount,
        currency: 'SOL',
        message: message || null,
        paymentMethod: 'solana',
        paymentId: 'pending', // Will be updated with tx signature
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
