/**
 * Start the hosted Stripe Checkout session behind `POST /pay/api/checkout`
 * (#2757): on the SELLER'S OWN Stripe account when the request names a seller,
 * on the platform's own account when it does not.
 *
 * There is no Stripe Connect and no platform-held fallback. A seller is charged
 * through the #1785 BYO connector (`resolveCardRail`) or not at all:
 * `SELLER_NO_CARD_RAIL`. The seller's payment settles from their own
 * `payment_intent.succeeded` event (`byo-checkout-settlement.ts`), which finds the
 * pending row by the `pay_transaction_id` this stamps on the session.
 */
import { createLogger } from '@imajin/logger';
import { createByoCheckoutSession, ByoCheckoutError } from '@/src/lib/stripe/byo-checkout';
import { resolveCardRail, SELLER_NO_CARD_RAIL } from './payment-requests/card-rail';
import { getPaymentService } from './pay';
import type { CheckoutBody, CheckoutItem } from './checkout';
import type { FiatCurrency } from './types';

const log = createLogger('kernel');

/** Stable reasons a card checkout could not start on the seller's own Stripe account, one per `ByoCheckoutError` code. */
const BYO_FAILURE_CODES = {
  no_key: 'CARD_RAIL_KEY_MISSING',
  key_rejected: 'CARD_RAIL_KEY_REJECTED',
  unavailable: 'CARD_RAIL_UNAVAILABLE',
  request_rejected: 'CARD_RAIL_REQUEST_REJECTED',
} as const;

export interface StartHostedCheckoutInput {
  body: CheckoutBody & { currency: FiatCurrency };
  /** Merchandise + one line per tax row — everything the payer is charged for. */
  items: CheckoutItem[];
  /** The metadata the session (and its PaymentIntent) carries. */
  metadata: Record<string, string>;
  /** Id of the pending `pay.transactions` row this checkout will be recorded as. */
  transactionId: string;
}

export type StartedHostedCheckout =
  | {
      ok: true;
      session: { id: string; url: string; expiresAt: Date };
      /** Set when the session lives on this seller's own Stripe account; absent for a platform-own charge. */
      byoSellerDid?: string;
    }
  | { ok: false; status: number; error: string; code?: string };

/** The seller a checkout charges, if it names one. */
export function sellerDidOf(body: CheckoutBody): string | undefined {
  return body.sellerDid || body.metadata?.sellerDid;
}

async function startSellerCheckout(sellerDid: string, input: StartHostedCheckoutInput): Promise<StartedHostedCheckout> {
  const { body, items, metadata, transactionId } = input;

  const rail = await resolveCardRail(sellerDid);
  if (rail.kind === 'none') {
    return { ok: false, status: 400, error: "This seller hasn't set up card payments", code: SELLER_NO_CARD_RAIL };
  }
  if (body.mode === 'subscription') {
    return {
      ok: false,
      status: 400,
      error: "Subscriptions can't be charged on a seller's own Stripe account",
      code: 'SUBSCRIPTION_NOT_SUPPORTED',
    };
  }

  try {
    const session = await createByoCheckoutSession(rail.ownerDid, {
      items,
      currency: body.currency || 'CAD',
      successUrl: body.successUrl,
      cancelUrl: body.cancelUrl,
      // `pay_transaction_id` is what the seller's own payment event names to settle this row.
      metadata: { ...metadata, pay_transaction_id: transactionId },
      ...(body.customerEmail && { customerEmail: body.customerEmail }),
    });
    return { ok: true, session, byoSellerDid: rail.ownerDid };
  } catch (error) {
    if (!(error instanceof ByoCheckoutError)) throw error;
    log.error(
      { err: error.message, code: error.code, stripeStatus: error.stripeStatus, sellerDid },
      "hosted checkout: could not create a Checkout Session on the seller's Stripe account",
    );
    return {
      ok: false,
      status: 502,
      error: "Card payment could not be started on the seller's Stripe account",
      code: BYO_FAILURE_CODES[error.code],
    };
  }
}

/** Create the hosted session: on the seller's own account when one is named, else a platform-own charge. */
export async function startHostedCheckout(input: StartHostedCheckoutInput): Promise<StartedHostedCheckout> {
  const sellerDid = sellerDidOf(input.body);
  if (sellerDid) return startSellerCheckout(sellerDid, input);

  const { body, items, metadata } = input;
  const session = await getPaymentService().checkout({
    items,
    currency: body.currency || 'CAD',
    mode: body.mode,
    customerEmail: body.customerEmail,
    successUrl: body.successUrl,
    cancelUrl: body.cancelUrl,
    metadata,
  });
  return { ok: true, session };
}
