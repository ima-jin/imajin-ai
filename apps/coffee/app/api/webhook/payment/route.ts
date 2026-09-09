import { NextRequest } from 'next/server';
import { createLogger } from '@imajin/logger';
const log = createLogger('coffee');
import { db, tips } from '@/db';
import { eq } from 'drizzle-orm';
import { settleTip } from '@/lib/settle';
import { publish } from '@imajin/bus';

/** Resolve the recipient DID and display title for the coffee page a tip was sent to */
async function resolvePageInfo(
  toDid: string | undefined,
  pageId: string | undefined
): Promise<{ recipientDid: string | undefined; pageTitle: string | undefined }> {
  let recipientDid = toDid;
  let pageTitle: string | undefined;
  if (pageId) {
    const page = await db.query.coffeePages.findFirst({
      where: (pages, { eq }) => eq(pages.id, pageId),
    });
    if (page) {
      recipientDid = recipientDid || page.did;
      pageTitle = page.title || page.handle;
    }
  }
  return { recipientDid, pageTitle };
}

/** Fall back to the tip record's stored amount when the webhook payload didn't include one */
async function resolveTipAmount(tipId: string): Promise<number | undefined> {
  const tip = await db.query.tips.findFirst({
    where: (t, { eq }) => eq(t.id, tipId),
  });
  return tip?.amount;
}

/** Notify the recipient and sender of a completed tip via the event bus (fire-and-forget) */
function publishTipNotifications(params: {
  tipId: string;
  recipientDid: string | undefined;
  fromDid: string | undefined;
  tipAmount: number | undefined;
  pageTitle: string | undefined;
  fromName: string | undefined;
}): void {
  const { tipId, recipientDid, fromDid, tipAmount, pageTitle, fromName } = params;
  const displayFrom = fromName || 'Anonymous';

  // Notify recipient + record interest via bus
  if (recipientDid) {
    publish('tip.granted', {
      issuer: fromDid || recipientDid,
      subject: recipientDid,
      scope: 'coffee',
      payload: {
        amount: tipAmount as number,
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
        amount: tipAmount as number,
        currency: 'USD',
        context_id: tipId,
        context_type: 'coffee',
        interestDids: [fromDid],
        pageName: pageTitle || 'a creator',
      },
    }).catch((err) => log.error({ err: String(err) }, '[webhook] Bus publish (tip.sent) error'));
  }
}

/** Handle a completed payment: mark the tip as completed, settle the .fair split, and notify parties */
async function handlePaymentSucceeded(params: {
  tipId: string;
  paymentId: string | undefined;
  amount: number | undefined;
  fromDid: string | undefined;
  fromName: string | undefined;
  to_did: string | undefined;
  pageId: string | undefined;
  stripeSessionId: string | undefined;
}): Promise<void> {
  const { tipId, paymentId, amount, fromDid, fromName, to_did: toDid, pageId, stripeSessionId } = params;

  // Update tip status
  await db
    .update(tips)
    .set({ status: 'completed', ...(paymentId && { paymentId }) })
    .where(eq(tips.id, tipId));
  log.info({ tipId }, 'Tip completed');

  // Resolve page info for emails and settlement
  const { recipientDid, pageTitle } = await resolvePageInfo(toDid, pageId);

  // Resolve tip amount — prefer webhook payload, fall back to tip record
  let tipAmount = amount;
  if (!tipAmount) {
    tipAmount = await resolveTipAmount(tipId);
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

  publishTipNotifications({ tipId, recipientDid, fromDid, tipAmount, pageTitle, fromName });
}

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
        await handlePaymentSucceeded({ tipId, paymentId, amount, fromDid, fromName, to_did, pageId, stripeSessionId });
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


