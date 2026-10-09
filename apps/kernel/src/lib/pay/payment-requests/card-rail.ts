/**
 * Card rail selection (#2754, #2757) — THE one place that answers "can this
 * seller take a card payment, and on which rail?". Payment requests, the
 * generic hosted checkout (events, market) and the buyer-facing "is card
 * available" check all ask here; nothing else knows how a card rail is chosen.
 *
 * There is exactly one card rail for a seller: their own Stripe account, through
 * the #1785 BYO connector (a sealed restricted key). No key = no card rail, and
 * the callers show no card button / answer `SELLER_NO_CARD_RAIL`. Stripe Connect
 * is gone (#2757) — there is no platform-held fallback.
 *
 * The connector rail requires BOTH a readable sealed key (`keySealed`: the
 * delegation grant behind it is active) AND the owner's `stripe:events` grant.
 * The second is what makes the money show up as Paid: settlement rides the
 * owner's own `stripe.*` event (`byo-settlement.ts`), and that event is only
 * published for an owner who granted the scope. A key that could charge but
 * could never settle is not a working rail, so it is not offered.
 */
import { createLogger } from '@imajin/logger';
import { stripe, STRIPE_EVENTS_SCOPE } from '@/src/lib/stripe/connector-core';

const log = createLogger('kernel');

/** Stable `code` a caller gets when the seller has no working card rail (#2757). */
export const SELLER_NO_CARD_RAIL = 'SELLER_NO_CARD_RAIL';

export type CardRail =
  /** Charge on the seller's own Stripe account with their sealed restricted key. */
  | { kind: 'connector'; ownerDid: string }
  /** No working card rail: the seller must be paid another way (e-Transfer) or not at all. */
  | { kind: 'none' };

async function hasConnectorRail(sellerDid: string): Promise<boolean> {
  return (await stripe.keySealed(sellerDid)) && (await stripe.resolveActiveGrant(sellerDid, STRIPE_EVENTS_SCOPE));
}

/**
 * The card rail `sellerDid` can charge on right now. Never throws: a lookup
 * failure is logged and reads as "that rail is not available" — the pay page
 * must render (and show the remaining rails) rather than 500.
 */
export async function resolveCardRail(sellerDid: string): Promise<CardRail> {
  try {
    if (await hasConnectorRail(sellerDid)) return { kind: 'connector', ownerDid: sellerDid };
  } catch (error) {
    log.error({ err: String(error), sellerDid }, 'card rail: connector lookup failed — treating as unavailable');
  }
  return { kind: 'none' };
}
