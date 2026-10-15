/**
 * Retired platform-account adapter. Kept only so legacy callers fail closed;
 * live card operations must resolve the transacting DID's sealed connector.
 * No ambient key, global client or credential cache is permitted here.
 */
import type Stripe from 'stripe';

/**
 * Retired: use the seller/node DID-bound adapters instead. Platform
 * payments (including old platform refunds) cannot acquire a client.
 */
export function getStripeClient(): Stripe {
  throw new Error('Legacy platform card payments are unavailable; use a DID-bound sealed connector');
}

/**
 * There is no process-wide card account. For node availability,
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
 * Retired platform session lookup. Preserve the async failure contract for
 * historical callers without attempting a query with unavailable credentials.
 */
export function findCheckoutSessionByPaymentIntent(
  _paymentIntentId: string,
): Promise<CheckoutSessionRef | null> {
  return Promise.reject(new Error('Legacy platform card payments are unavailable; use a DID-bound sealed connector'));
}
