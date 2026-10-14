import { and, eq } from 'drizzle-orm';
import { db, transactions } from '@/src/db';
import { sellerPledgeRefundClient } from './providers/seller-pledge-refund';
import { resolveDidStripeKeys } from './rails/stripe-keys';
import { STRIPE_BYO_RAIL } from './external-ref';

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
  priorStatus: string;
  metadata: Record<string, unknown>;
  sellerDid: string;
  appDid: string;
  buyerDid: string | null;
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
    // Only setup-intent writes this first-class marker. Generic checkout's
    // caller-controlled type/metadata cannot impersonate an authorized setup.
    const [row] = await db.select().from(transactions)
      .where(eq(transactions.idempotencyKey, `pledge-setup:${ref.setupIntentId}`)).limit(1);
    const metadata = row?.metadata as Record<string, unknown> | null;
    if (row?.appDid !== appDid || row.type !== 'pledge' || metadata?.eventId !== eventId) {
      return { error: 'Forbidden - pledge was not created by this app for this campaign', status: 403 };
    }
    const amount = Math.round(Number(row.amount) * 100);
    if (row.rail !== STRIPE_BYO_RAIL || !row.toDid) {
      return { error: 'Legacy platform pledges cannot be charged; recreate setup on the seller account', status: 409 };
    }
    if (!Number.isSafeInteger(amount) || amount <= 0 || typeof metadata.stripeCustomerId !== 'string') {
      return { error: 'Pledge has no valid recorded payment details', status: 409 };
    }
    if (!['pending', 'completed', 'processing'].includes(row.status)) {
      return { error: 'Pledge is not chargeable', status: 409 };
    }
    result.push({
      pledgeId: ref.pledgeId,
      setupIntentId: ref.setupIntentId,
      transactionId: row.id,
      amount,
      currency: row.currency.toLowerCase(),
      customerId: metadata.stripeCustomerId,
      priorStatus: row.status,
      metadata,
      sellerDid: row.toDid,
      appDid,
      buyerDid: row.fromDid,
    });
  }
  return result;
}

/** Only Stripe's confirmed setup may supply the saved card; not the HTTP caller. */
export async function chargeBoundPledge(pledge: BoundPledge, eventId: string): Promise<string> {
  if (pledge.priorStatus === 'completed') return 'succeeded';
  if (pledge.priorStatus === 'processing') return 'processing';
  const { secretKey } = await resolveDidStripeKeys(pledge.sellerDid);
  const stripe = sellerPledgeRefundClient(secretKey);
  const setup = await stripe.setupIntents.retrieve(pledge.setupIntentId);
  const customer = typeof setup.customer === 'string' ? setup.customer : setup.customer?.id;
  const paymentMethod = typeof setup.payment_method === 'string' ? setup.payment_method : setup.payment_method?.id;
  if (setup.status !== 'succeeded' || customer !== pledge.customerId || !paymentMethod ||
      setup.metadata?.app_did !== pledge.appDid || setup.metadata?.sellerDid !== pledge.sellerDid ||
      setup.metadata?.did !== pledge.buyerDid || setup.metadata?.eventId !== eventId ||
      setup.metadata?.amount !== String(pledge.amount) || setup.metadata?.currency !== pledge.currency.toUpperCase()) {
    throw new Error('Pledge setup is not confirmed for the recorded customer');
  }
  const [recordedCustomer, method] = await Promise.all([
    stripe.customers.retrieve(pledge.customerId),
    stripe.paymentMethods.retrieve(paymentMethod),
  ]);
  const methodCustomer = typeof method.customer === 'string' ? method.customer : method.customer?.id;
  if (recordedCustomer.deleted || recordedCustomer.metadata.did !== pledge.buyerDid ||
      (recordedCustomer.metadata.buyerDid !== undefined && recordedCustomer.metadata.buyerDid !== pledge.buyerDid) ||
      methodCustomer !== pledge.customerId) {
    throw new Error('Pledge saved card does not match the recorded buyer');
  }
  // Claim once before the rail call. An interrupted charge is never retried
  // after Stripe's idempotency retention expires: it needs reconciliation.
  const claimed = await db.update(transactions).set({ status: 'charging' }).where(and(
    eq(transactions.id, pledge.transactionId), eq(transactions.status, 'pending'),
  )).returning({ id: transactions.id });
  if (claimed.length === 0) throw new Error('Pledge charge already claimed; reconcile before retrying');
  const payment = await stripe.paymentIntents.create({
    amount: pledge.amount,
    currency: pledge.currency,
    customer: pledge.customerId,
    payment_method: paymentMethod,
    off_session: true,
    confirm: true,
    metadata: { eventId, pledgeId: pledge.pledgeId, type: 'campaign_pledge_charge', sellerDid: pledge.sellerDid, appDid: pledge.appDid },
  }, { idempotencyKey: `pledge-charge:${pledge.transactionId}` });
  if (payment.status === 'succeeded' || payment.status === 'processing') {
    await db.update(transactions).set({
      status: payment.status === 'succeeded' ? 'completed' : 'processing',
      ...(payment.status === 'succeeded' && { sourceKind: 'receipt' }),
      externalRef: payment.id,
      metadata: { ...pledge.metadata, setupIntentId: pledge.setupIntentId, paymentIntentId: payment.id },
    }).where(eq(transactions.id, pledge.transactionId));
  }
  return payment.status;
}
