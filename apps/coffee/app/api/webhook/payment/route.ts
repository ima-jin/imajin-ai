import { NextRequest } from 'next/server';
import { db, tips, coffeePages } from '@/db';
import { eq } from 'drizzle-orm';
import { settleTip } from '@/lib/settle';
import { notify } from '@imajin/notify';
import { getEmailForDid } from '@imajin/auth';

const PROFILE_SERVICE_URL = process.env.PROFILE_SERVICE_URL || 'http://localhost:3005';
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
      type, tipId, paymentId, amount, fromDid, fromName, fromEmail,
      to_did, pageId, pageHandle, message, stripeSessionId,
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
        console.log(`Tip ${tipId} completed`);

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
          console.warn(`[webhook] Cannot settle tip ${tipId} — missing recipientDid or amount`);
        }

        // Format amount for display
        const displayAmount = tipAmount ? `$${(tipAmount / 100).toFixed(2)}` : 'a tip';
        const displayFrom = fromName || 'Anonymous';
        const pageUrl = handle ? `${COFFEE_URL}/${handle}` : COFFEE_URL;

        // Notify recipient
        if (recipientDid) {
          const recipientEmail = await resolveEmailForDid(recipientDid).catch(() => null);
          notify.send({
            to: recipientDid,
            scope: "coffee:tip",
            data: {
              ...(recipientEmail && { email: recipientEmail }),
              amount: displayAmount,
              tipperName: displayFrom,
            },
          }).catch((err) => console.error('[webhook] Notify recipient error:', err));
        }

        // Notify sender
        if (fromDid) {
          notify.send({
            to: fromDid,
            scope: "coffee:tip-sent",
            data: {
              ...(fromEmail && { email: fromEmail }),
              amount: displayAmount,
              pageName: pageTitle || 'a creator',
            },
          }).catch((err) => console.error('[webhook] Notify sender error:', err));
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

/**
 * Look up email for a DID via profile service, with credentials table as fallback.
 */
async function resolveEmailForDid(did: string): Promise<string | null> {
  // Try profile contact email first (user's preferred transactional email)
  try {
    const res = await fetch(`${PROFILE_SERVICE_URL}/api/profile/${encodeURIComponent(did)}`, {
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
    });
    if (res.ok) {
      const profile = await res.json();
      if (profile.contactEmail) return profile.contactEmail;
    }
  } catch {
    // Fall through to credentials lookup
  }

  // Fall back to auth credentials (login email)
  return getEmailForDid(did);
}
