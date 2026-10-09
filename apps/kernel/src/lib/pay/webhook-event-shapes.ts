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
  /**
   * Kernel-internal, never a Stripe field: the `pay.transactions` id when the caller already knows it
   * (#2757 — the BYO settlement, whose row is on the `stripe-byo` rail and so is not found by the
   * platform-rail session lookup). A real Stripe session carries no such property, so a client cannot
   * inject one through checkout metadata.
   */
  transactionId?: string;
  /**
   * The pay rail the payment was collected on, when the kernel already settled it there (#2773).
   * `stripe-byo` = the seller's own Stripe account: the row is completed and there is nothing for
   * the originating app to settle on-platform. Absent = a platform-collected payment.
   */
  rail?: string;
  /**
   * Kernel-internal, never a Stripe field: the DID whose own Stripe account collected the payment,
   * set by the BYO settlement from the checkout's verified owner (the row's `to_did`). Unlike
   * `metadata.sellerDid`, which is whatever the caller of `POST /pay/api/checkout` put there, this
   * is attested by the kernel, so an app can check it against the owner of what was bought.
   */
  sellerDid?: string;
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
