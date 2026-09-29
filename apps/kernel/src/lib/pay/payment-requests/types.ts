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
  /** #2421 — `'1.2'` exactly when `taxes[]` is present (#2419's `.fair` version for trust-liability tax); omitted otherwise. */
  fair?: string;
  fees: unknown[];
  chain: unknown[];
  distributions: unknown[];
  attribution: unknown[];
  total: { amount: number; currency: string };
  /**
   * #2419/#2421 — present when the request charges trust-liability tax.
   * `total` above stays the PRE-TAX subtotal (the same `Money` the line
   * items sum to — see `service.ts`'s `validateLineItems`/
   * `validateCustomPaymentRequestManifest`) and equals the row's
   * `subtotal_amount`, NOT its `total_amount` (which is subtotal + tax);
   * tax is added on top as separate Stripe line items. Every
   * `taxes[].basisAmount` must equal `total.amount`.
   */
  taxes?: Array<{
    jurisdiction: string;
    kind: string;
    rateBps: number;
    basisAmount: number;
    amount: number;
    collectorDid: string;
    remitTo: string;
    registrationNumber: string;
  }>;
}

/** One tax line as shown on the pay page and carried by receipt attestations (#2421). `registrationNumber` prints next to the tax line — it is public by design (#2420). */
export interface PaymentRequestTaxLine {
  jurisdiction: string;
  kind: string;
  rateBps: number;
  /** Minor units. */
  amount: number;
  registrationNumber: string;
}

/** Subtotal → tax → total breakdown of a payment_request that charges tax (#2421); `total = subtotalAmount + taxTotalAmount`. */
export interface PaymentRequestTaxBreakdown {
  subtotalAmount: number;
  taxTotalAmount: number;
  taxes: PaymentRequestTaxLine[];
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
