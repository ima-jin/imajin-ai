export type { PaymentRequestKind, PaymentRequestStatus } from '@/src/db';

/** A single line item on a payment_request. Mirrors `CheckoutItem`'s shape (`apps/kernel/src/lib/pay/checkout.ts`) for consistency across pay surfaces. */
export interface PaymentRequestLineItem {
  name: string;
  description?: string;
  /** Unit price in minor units (e.g. cents), per `packages/money`. */
  amount: number;
  quantity: number;
}

/** A `.fair` fee manifest (the shape `buildFairManifest` returns) plus the `total` it was built against — see `manifest.ts` for why `total` rides alongside the fee chain. */
export interface PaymentRequestFairManifest {
  version: string;
  fees: unknown[];
  chain: unknown[];
  distributions: unknown[];
  attribution: unknown[];
  total: { amount: number; currency: string };
}

export type PaymentRequestSettlementMethod = 'manual' | 'stripe' | 'mjnx';

export interface PaymentRequestSettlementRef {
  method: PaymentRequestSettlementMethod;
  note?: string;
  /** Who asserted the settlement — the caller DID for `manual`. Omitted for `stripe` (#2209): that path is kernel-signed, not a human assertion. */
  asserted_by?: string;
  settled_at: string;
  /** `method: 'stripe'` only (#2209) — the Checkout session that paid this request. */
  checkout_session_id?: string;
  /** `method: 'stripe'` only (#2209) — the underlying PaymentIntent, when Stripe reports one. */
  payment_intent_id?: string | null;
}
