/**
 * Retired platform-account adapter. Kept only so legacy callers fail closed;
 * live card operations must resolve the transacting DID's sealed connector.
 * No ambient key, global client or credential cache is permitted here.
 */
import type Stripe from 'stripe';

/**
 * @deprecated Use the seller/node DID-bound adapters instead. Platform
 * payments (including old platform refunds) cannot acquire a client.
 */
export function getStripeClient(): Stripe {
  throw new Error('Legacy platform card payments are unavailable; use a DID-bound sealed connector');
}

/**
 * @deprecated There is no process-wide card account. For node availability,
 * use isNodeCardRailConfigured; sellers must resolve their own card rail.
 */
export function isStripeConfigured(): boolean {
  return false;
}

/**
 * Minimal, domain-shaped reference to a Stripe Checkout Session —
 * deliberately NOT `Stripe.Checkout.Session`, so callers outside this
 * adapter (e.g. `refund.ts`) never need to import Stripe SDK types.
 */
export interface CheckoutSessionRef {
  id: string;
}

/**
 * Resolve a Stripe checkout session (`cs_xxx`) from a payment intent ID
 * (`pi_xxx`). Used by `refund.ts` for callers (e.g. events tickets) that
 * only know the payment intent ID. Returns `null` when no session matches.
 */
export async function findCheckoutSessionByPaymentIntent(
  paymentIntentId: string,
): Promise<CheckoutSessionRef | null> {
  const stripe = getStripeClient();
  const sessions = await stripe.checkout.sessions.list({ payment_intent: paymentIntentId, limit: 1 });
  const session = sessions.data[0];
  return session ? { id: session.id } : null;
}
