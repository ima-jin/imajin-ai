import Stripe from 'stripe';
import type { ChargeRequest, ChargeResult, Currency, EscrowRequest, EscrowResult, PaymentStatus } from '../types';

/** No singleton or environment fallback: each client belongs to one sealed seller key. */
export function createSellerStripeClient(secretKey: string): Stripe {
  if (!secretKey) throw new Error('Seller card key is required');
  return new Stripe(secretKey, { apiVersion: '2024-11-20.acacia' as Stripe.LatestApiVersion });
}

function paymentStatus(status: Stripe.PaymentIntent.Status): PaymentStatus {
  switch (status) {
    case 'succeeded': return 'succeeded';
    case 'processing': return 'pending';
    case 'requires_action':
    case 'requires_confirmation':
    case 'requires_payment_method': return 'requires_action';
    case 'canceled': return 'canceled';
    default: return 'failed';
  }
}

export async function chargeSeller(
  secretKey: string, sellerDid: string, request: ChargeRequest,
): Promise<ChargeResult> {
  const customerId = 'stripeCustomerId' in request.to ? request.to.stripeCustomerId : undefined;
  const intent = await createSellerStripeClient(secretKey).paymentIntents.create({
    amount: request.amount,
    currency: request.currency.toLowerCase(),
    customer: customerId,
    description: request.description,
    automatic_payment_methods: { enabled: true },
    metadata: {
      ...request.metadata,
      from_did: request.from || '',
      to_did: sellerDid,
      seller_did: sellerDid,
      rail: 'stripe-byo',
    },
  }, { idempotencyKey: request.idempotencyKey });
  return {
    id: intent.id, provider: 'stripe', status: paymentStatus(intent.status),
    amount: intent.amount, currency: request.currency,
    clientSecret: intent.client_secret || undefined,
    createdAt: new Date(intent.created * 1000), metadata: intent.metadata,
  };
}

export async function escrowSeller(
  secretKey: string, request: EscrowRequest,
): Promise<EscrowResult & { clientSecret?: string }> {
  const intent = await createSellerStripeClient(secretKey).paymentIntents.create({
    amount: request.amount, currency: request.currency.toLowerCase(),
    capture_method: 'manual',
    metadata: {
      ...request.metadata,
      escrow: 'true', from_did: request.from, to_did: request.to,
      seller_did: request.to, arbiter_did: request.arbiter || '', rail: 'stripe-byo',
    },
  });
  return {
    id: intent.id, provider: 'stripe', status: 'held', amount: request.amount,
    currency: request.currency, from: request.from, to: request.to,
    createdAt: new Date(intent.created * 1000),
    clientSecret: intent.client_secret || undefined,
  };
}

export async function updateSellerEscrow(
  secretKey: string, externalRef: string, action: 'release' | 'refund',
): Promise<EscrowResult> {
  const stripe = createSellerStripeClient(secretKey);
  const intent = action === 'refund'
    ? await stripe.paymentIntents.cancel(externalRef)
    : await stripe.paymentIntents.capture(externalRef);
  return {
    id: intent.id, provider: 'stripe', status: action === 'refund' ? 'refunded' : 'released',
    amount: intent.amount, currency: intent.currency.toUpperCase() as Currency,
    from: intent.metadata.from_did || '', to: intent.metadata.to_did || '',
    createdAt: new Date(intent.created * 1000),
  };
}
