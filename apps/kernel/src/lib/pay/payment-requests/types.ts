import type { PaymentRequestKind, PaymentRequestStatus } from '@/src/db';

export type { PaymentRequestKind, PaymentRequestStatus };

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
  asserted_by: string;
  settled_at: string;
}
