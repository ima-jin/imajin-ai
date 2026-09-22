/**
 * Stripe SDK client factory (#2174).
 *
 * The ONE place `STRIPE_SECRET_KEY` is read and the ONE place `new
 * Stripe(...)` is constructed for the platform's own Stripe account.
 * Before this module existed, three separate call sites each built their
 * own client from the raw env var:
 *   - `lib/pay/stripe.ts`'s `getStripe()` singleton (deleted by this change)
 *   - `providers/stripe.ts`'s `StripeProvider` constructor
 *   - `refund.ts`'s ad-hoc `(await import('stripe')).default` + `new Stripe(...)`
 *
 * Every call site that needs live Stripe API access now imports
 * `getStripeClient()` from here instead. `refund.ts` specifically goes
 * through `findCheckoutSessionByPaymentIntent` below rather than importing
 * `getStripeClient()` directly, so it never needs to import a raw `stripe`
 * SDK type — this module's public surface exposes only domain-shaped types
 * to callers outside the `providers/` adapter layer.
 *
 * See `scripts/ci-guard-stripe-import-scope.mjs` for the companion guard
 * that keeps the raw `stripe` SDK *import* scoped to `providers/`, and
 * `__tests__/stripe-client.test.ts`'s grep guard for the single-read-site
 * invariant on `STRIPE_SECRET_KEY` specifically.
 */
import Stripe from 'stripe';

let _stripe: Stripe | null = null;

/**
 * Lazily construct (and cache) the single Stripe SDK client for this
 * process. Throws a clear, actionable error when `STRIPE_SECRET_KEY` is
 * absent instead of letting the Stripe SDK reject with its own generic
 * "Neither apiKey nor config.authenticator provided" message.
 */
export function getStripeClient(): Stripe {
  if (!_stripe) {
    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      throw new Error('STRIPE_SECRET_KEY not configured');
    }
    _stripe = new Stripe(secretKey, {
      apiVersion: '2024-11-20.acacia' as Stripe.LatestApiVersion,
    });
  }
  return _stripe;
}

/**
 * Whether Stripe is configured for this process, without throwing — lets
 * callers (e.g. `pay.ts`'s provider registration) gate optional
 * Stripe-backed features without constructing a client just to probe it.
 */
export function isStripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
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

/**
 * Test-only: reset the cached singleton so tests can exercise lazy-init and
 * missing-key paths independently of each other and of call order.
 */
export function __resetStripeClientForTests(): void {
  _stripe = null;
}
