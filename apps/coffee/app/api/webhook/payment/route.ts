import { NextRequest } from 'next/server';
import { db, tips } from '@/db';
import { eq } from 'drizzle-orm';

/**
 * POST /api/webhook/payment - Receives payment callbacks from pay service
 *
 * Body:
 * - type: 'payment.succeeded' | 'payment.failed' | 'checkout.completed'
 * - tipId: string
 * - pageId: string
 * - amount: number
 * - paymentId: string
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
    const { type, tipId, paymentId } = await request.json();

    if (!tipId) {
      return Response.json({ received: true }); // Not a tip event
    }

    switch (type) {
      case 'payment.succeeded':
      case 'checkout.completed': {
        await db
          .update(tips)
          .set({ status: 'completed', ...(paymentId && { paymentId }) })
          .where(eq(tips.id, tipId));
        console.log(`Tip ${tipId} completed`);
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
