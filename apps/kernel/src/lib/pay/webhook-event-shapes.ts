/**
 * Rail-neutral, Stripe-shaped webhook payload interfaces (#2175).
 *
 * These are deliberately NOT `Stripe.*` types — they exist so that
 * `webhook-handlers.ts` and the two pay webhook routes can keep reading the
 * same fields they always have (id, amount, currency, metadata, ...)
 * without ever importing the `stripe` SDK themselves. Every field here is a
 * hand-picked subset of the real Stripe object actually read by this
 * codebase; extend a shape here (not with an inline `as any`) the next time
 * a handler needs a new field.
 *
 * Only the adapter under `providers/stripe-webhook.ts` is allowed to know
 * the real `Stripe.*` types — see `scripts/ci-guard-stripe-import-scope.mjs`.
 */

/**
 * Mirrors Stripe SDK's own `Metadata` type shape (`{ [key: string]: string
 * }`, no implicit `| undefined` on access) so existing call sites that read
 * an arbitrary key without an `?.` / fallback keep type-checking exactly as
 * they did against the real `Stripe.Metadata` type.
 */
export type StripeMetadataLike = Record<string, string>;

export interface StripeCheckoutSessionLike {
  id: string;
  amount_total: number | null;
  currency: string | null;
  customer_email?: string | null;
  customer_details?: { email?: string | null; name?: string | null } | null;
  metadata?: StripeMetadataLike | null;
  payment_intent?: string | { id: string } | null;
}

export interface StripePaymentIntentLike {
  id: string;
  amount: number;
  currency: string;
  metadata: StripeMetadataLike;
  last_payment_error?: { message?: string | null } | null;
  receipt_email?: string | null;
}

export interface StripeSubscriptionLike {
  id: string;
  customer: string | { id: string };
  status: string;
  currency?: string | null;
  metadata?: StripeMetadataLike | null;
  items: { data: Array<{ price?: { unit_amount?: number | null } | null }> };
}

export interface StripeInvoiceLike {
  id: string;
  amount_paid: number;
  currency: string;
  number?: string | null;
  subscription?: string | { id: string } | null;
  subscription_details?: { metadata?: StripeMetadataLike | null } | null;
}

export interface StripeAccountLike {
  id: string;
  charges_enabled?: boolean | null;
  payouts_enabled?: boolean | null;
  details_submitted?: boolean | null;
  requirements?: { currently_due?: string[] | null; eventually_due?: string[] | null } | null;
}

export interface StripePayoutLike {
  id: string;
  amount: number;
  currency: string;
}
