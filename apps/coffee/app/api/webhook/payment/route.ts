import { NextRequest } from 'next/server';
import { db, tips, coffeePages } from '@/db';
import { eq } from 'drizzle-orm';
import { settleTip } from '@/lib/settle';

/**
 * POST /api/webhook/payment - Receives payment callbacks from pay service
 *
 * Body:
 * - type: 'payment.succeeded' | 'payment.failed' | 'checkout.completed'
 * - tipId: string
 * - pageId: string
 * - amount: number
 * - paymentId: string
 * - fromDid: string
 * - to_did: string
 * - status: string
 */
export async function POST(request: NextRequest) {
  const webhookSecret = process.env.WEBHOOK_SECRET;
  if (!webhookSecret) {
    return Response.json({ error: 'Webhook not configured' }, { status: 500 });
  }

  const authHeader = request.headers.get('authorization');
  if (!authHeader || authHeader !== `Bearer ${webhookSecret}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { type, tipId, paymentId, amount, fromDid, to_did, pageId, stripeSessionId } = await request.json();

    if (!tipId) {
      return Response.json({ received: true }); // Not a tip event
    }

    switch (type) {
      case 'payment.succeeded':
      case 'checkout.completed': {
        // Update tip status
        await db
          .update(tips)
          .set({ status: 'completed', ...(paymentId && { paymentId }) })
          .where(eq(tips.id, tipId));
        console.log(`Tip ${tipId} completed`);

        // Resolve recipient DID — prefer webhook payload, fall back to page lookup
        let recipientDid = to_did;
        if (!recipientDid && pageId) {
          const page = await db.query.coffeePages.findFirst({
            where: (pages, { eq }) => eq(pages.id, pageId),
          });
          recipientDid = page?.did;
        }

        // Resolve amount — prefer webhook payload, fall back to tip record
        let tipAmount = amount;
        if (!tipAmount) {
          const tip = await db.query.tips.findFirst({
            where: (t, { eq }) => eq(t.id, tipId),
          });
          tipAmount = tip?.amount;
        }

        if (recipientDid && tipAmount) {
          // Settle the .fair split
          await settleTip({
            tipId,
            recipientDid,
            fromDid: fromDid || null,
            amount: tipAmount,
            currency: 'USD',
            stripeSessionId,
          });
        } else {
          console.warn(`[webhook] Cannot settle tip ${tipId} — missing recipientDid or amount`);
        }

        break;
      }

      case 'payment.failed': {
        await db
          .update(tips)
          .set({ status: 'failed' })
          .where(eq(tips.id, tipId));
        console.log(`Tip ${tipId} failed`);
        break;
      }

      default:
        console.log(`Unhandled coffee webhook type: ${type}`);
    }

    return Response.json({ received: true });
  } catch (error) {
    console.error('Coffee webhook handler error:', error);
    return Response.json({ error: 'Webhook handler failed' }, { status: 500 });
  }
}
