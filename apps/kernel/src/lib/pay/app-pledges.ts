import { eq } from 'drizzle-orm';
import { db, transactions } from '@/src/db';
import { whereExternalRef } from './external-ref';
import { getStripeClient } from './providers/stripe-client';

type Failure = { error: string; status: number };
export interface PledgeReference {
  pledgeId: string;
  setupIntentId: string;
}
export interface BoundPledge {
  pledgeId: string;
  transactionId: string;
  setupIntentId: string;
  amount: number;
  currency: string;
  customerId: string;
  alreadyCharged: boolean;
}

/** Preflight the entire batch before any charge: caller fields never establish ownership. */
export async function loadAppPledges(
  appDid: string,
  eventId: string,
  refs: PledgeReference[],
): Promise<BoundPledge[] | Failure> {
  const result: BoundPledge[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    if (!ref || typeof ref.pledgeId !== 'string' || !ref.pledgeId ||
        typeof ref.setupIntentId !== 'string' || !ref.setupIntentId || seen.has(ref.setupIntentId)) {
      return { error: 'Each pledge requires a unique setupIntentId and a pledgeId', status: 400 };
    }
    seen.add(ref.setupIntentId);
    const [row] = await db.select().from(transactions).where(whereExternalRef(ref.setupIntentId)).limit(1);
    const metadata = row?.metadata as Record<string, unknown> | null;
    if (!row || row.appDid !== appDid || row.type !== 'pledge' || metadata?.eventId !== eventId) {
      return { error: 'Forbidden - pledge was not created by this app for this campaign', status: 403 };
    }
    const amount = Math.round(Number(row.amount) * 100);
    if (!Number.isSafeInteger(amount) || amount <= 0 || typeof metadata.stripeCustomerId !== 'string') {
      return { error: 'Pledge has no valid recorded payment details', status: 409 };
    }
    if (row.status !== 'pending' && row.status !== 'completed') {
      return { error: 'Pledge is not chargeable', status: 409 };
    }
    result.push({
      pledgeId: ref.pledgeId,
      setupIntentId: ref.setupIntentId,
      transactionId: row.id,
      amount,
      currency: row.currency.toLowerCase(),
      customerId: metadata.stripeCustomerId,
      alreadyCharged: row.status === 'completed',
    });
  }
  return result;
}

/** Only Stripe's confirmed setup may supply the saved card; not the HTTP caller. */
export async function chargeBoundPledge(pledge: BoundPledge, eventId: string): Promise<string> {
  if (pledge.alreadyCharged) return 'succeeded';
  const stripe = getStripeClient();
  const setup = await stripe.setupIntents.retrieve(pledge.setupIntentId);
  const customer = typeof setup.customer === 'string' ? setup.customer : setup.customer?.id;
  const paymentMethod = typeof setup.payment_method === 'string' ? setup.payment_method : setup.payment_method?.id;
  if (setup.status !== 'succeeded' || customer !== pledge.customerId || !paymentMethod) {
    throw new Error('Pledge setup is not confirmed for the recorded customer');
  }
  const payment = await stripe.paymentIntents.create({
    amount: pledge.amount,
    currency: pledge.currency,
    customer: pledge.customerId,
    payment_method: paymentMethod,
    off_session: true,
    confirm: true,
    metadata: { eventId, pledgeId: pledge.pledgeId, type: 'campaign_pledge_charge' },
  }, { idempotencyKey: `pledge-charge:${pledge.transactionId}` });
  if (payment.status === 'succeeded' || payment.status === 'processing') {
    await db.update(transactions).set({
      status: 'completed',
      sourceKind: 'receipt',
    }).where(eq(transactions.id, pledge.transactionId));
  }
  return payment.status;
}
