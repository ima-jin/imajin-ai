import Stripe from 'stripe';

/** Explicit seller keys only. Never cache a client across accounts or read environment keys. */
export function sellerPledgeRefundClient(secretKey: string) {
  if (!secretKey) throw new Error('Seller card rail unavailable');
  return new Stripe(secretKey, { apiVersion: '2024-11-20.acacia' as Stripe.LatestApiVersion });
}

/** Stripe's ordinary customer list cannot filter metadata. Search on this seller account. */
export async function findOrCreatePledgeCustomer(secretKey: string, buyerDid: string) {
  const stripe = sellerPledgeRefundClient(secretKey);
  const escaped = buyerDid.replace(/\\/g, String.raw`\\`).replace(/'/g, String.raw`\'`);
  const customers = await stripe.customers.search({ query: `metadata['did']:'${escaped}'`, limit: 1 });
  const customer = customers.data.find((row) => row.metadata.did === buyerDid);
  return customer ?? stripe.customers.create({ metadata: { did: buyerDid, buyerDid } });
}

export async function sellerSessionPaymentIntent(secretKey: string, sessionId: string): Promise<string | undefined> {
  const session = await sellerPledgeRefundClient(secretKey).checkout.sessions.retrieve(sessionId);
  return typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
}
