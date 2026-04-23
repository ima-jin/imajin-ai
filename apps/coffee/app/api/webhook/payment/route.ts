import { NextRequest } from 'next/server';
import { createLogger } from '@imajin/logger';
const log = createLogger('coffee');
import { db, tips, coffeePages } from '@/db';
import { eq } from 'drizzle-orm';
import { settleTip } from '@/lib/settle';
import { publish } from '@imajin/bus';

const COFFEE_URL = process.env.NEXT_PUBLIC_COFFEE_URL || 'https://coffee.imajin.ai';

/**
 * POST /api/webhook/payment - Receives payment callbacks from pay service
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
    const {
      type, tipId, paymentId, amount, fromDid, fromName,
      to_did, pageId, pageHandle, stripeSessionId,
    } = await request.json();

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
        log.info({ tipId }, 'Tip completed');

        // Resolve page info for emails and settlement
        let recipientDid = to_did;
        let handle = pageHandle;
        let pageTitle: string | undefined;
        if (pageId) {
          const page = await db.query.coffeePages.findFirst({
            where: (pages, { eq }) => eq(pages.id, pageId),
          });
          if (page) {
            recipientDid = recipientDid || page.did;
            handle = handle || page.handle;
            pageTitle = page.title || page.handle;
          }
        }

        // Resolve tip amount — prefer webhook payload, fall back to tip record
        let tipAmount = amount;
        if (!tipAmount) {
          const tip = await db.query.tips.findFirst({
            where: (t, { eq }) => eq(t.id, tipId),
          });
          tipAmount = tip?.amount;
        }

        // Settle the .fair split
        if (recipientDid && tipAmount) {
          await settleTip({
            tipId,
            recipientDid,
            fromDid: fromDid || null,
            amount: tipAmount,
            currency: 'USD',
            stripeSessionId,
          });
        } else {
          log.warn({ tipId }, '[webhook] Cannot settle tip — missing recipientDid or amount');
        }

        const displayFrom = fromName || 'Anonymous';

        // Notify recipient + record interest via bus
        if (recipientDid) {
          publish('tip.granted', {
            issuer: fromDid || recipientDid,
            subject: recipientDid,
            scope: 'coffee',
            payload: {
              amount: tipAmount,
              currency: 'USD',
              context_id: tipId,
              context_type: 'coffee',
              interestDids: [recipientDid],
              tipperName: displayFrom,
            },
          }).catch((err) => log.error({ err: String(err) }, '[webhook] Bus publish (tip.granted) error'));
        }

        // Notify sender + record interest via bus
        if (fromDid) {
          publish('tip.sent', {
            issuer: recipientDid || fromDid,
            subject: fromDid,
            scope: 'coffee',
            payload: {
              amount: tipAmount,
              currency: 'USD',
              context_id: tipId,
              context_type: 'coffee',
              interestDids: [fromDid],
              pageName: pageTitle || 'a creator',
            },
          }).catch((err) => log.error({ err: String(err) }, '[webhook] Bus publish (tip.sent) error'));
        }

        break;
      }

      case 'payment.failed': {
        await db
          .update(tips)
          .set({ status: 'failed' })
          .where(eq(tips.id, tipId));
        log.info({ tipId }, 'Tip failed');
        break;
      }

      default:
        log.info({ type }, 'Unhandled coffee webhook type');
    }

    return Response.json({ received: true });
  } catch (error) {
    log.error({ err: String(error) }, 'Coffee webhook handler error');
    return Response.json({ error: 'Webhook handler failed' }, { status: 500 });
  }
}


