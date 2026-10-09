/**
 * Card rail selection for a payment_request (#2754) — THE one place that
 * answers "can this issuer take a card payment, and on which rail?".
 *
 * Order: the issuer's own Stripe connector (#1785, a BYO restricted key)
 * first; Stripe Connect only as a TEMPORARY fallback for the accounts that
 * have not migrated yet; neither = no card rail, and the pay page shows no
 * card button at all.
 *
 *   #2757 (remove Connect) deletes, and only needs to delete:
 *     1. the `connect` member of {@link CardRail},
 *     2. `hasConnectRail` and its one call in {@link resolveCardRail},
 *     3. `resolveConnectCheckout`,
 *     4. the `connect` branches in `checkout.ts` (each marked `#2757`).
 *   Every caller already goes through `resolveCardRail`, so nothing else
 *   knows Connect exists.
 *
 * The connector rail requires BOTH a readable sealed key (`keySealed`: the
 * delegation grant behind it is active) AND the owner's `stripe:events` grant.
 * The second is what makes the money show up as Paid: settlement rides the
 * owner's own `stripe.*` event (`byo-settlement.ts`), and that event is only
 * published for an owner who granted the scope. A key that could charge but
 * could never settle is not a working rail, so it is not offered.
 */
import { and, eq } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';
import { db, connectedAccounts } from '@/src/db';
import { stripe, STRIPE_EVENTS_SCOPE } from '@/src/lib/stripe/connector-core';
import { resolveConnectedAccountFee, type CheckoutBody } from '../checkout';

const log = createLogger('kernel');

export type CardRail =
  /** Charge on the issuer's own Stripe account with their sealed restricted key. */
  | { kind: 'connector'; ownerDid: string }
  /** #2757: temporary — destination charge through the platform's Stripe Connect. */
  | { kind: 'connect' }
  /** No working card rail: the issuer must pay another way (e-Transfer) or not at all. */
  | { kind: 'none' };

async function hasConnectorRail(issuerDid: string): Promise<boolean> {
  return (await stripe.keySealed(issuerDid)) && (await stripe.resolveActiveGrant(issuerDid, STRIPE_EVENTS_SCOPE));
}

/** #2757: a Connect account that can actually take a charge. */
async function hasConnectRail(issuerDid: string): Promise<boolean> {
  const [account] = await db
    .select({ id: connectedAccounts.stripeAccountId })
    .from(connectedAccounts)
    .where(and(eq(connectedAccounts.did, issuerDid), eq(connectedAccounts.chargesEnabled, true)))
    .limit(1);
  return Boolean(account);
}

/**
 * The card rail `issuerDid` can charge on right now. Never throws: a lookup
 * failure is logged and reads as "that rail is not available" — the pay page
 * must render (and show the remaining rails) rather than 500.
 */
export async function resolveCardRail(issuerDid: string): Promise<CardRail> {
  try {
    if (await hasConnectorRail(issuerDid)) return { kind: 'connector', ownerDid: issuerDid };
  } catch (error) {
    log.error({ err: String(error), issuerDid }, 'card rail: connector lookup failed — treating as unavailable');
  }

  // #2757: delete from here to the end of the function body's Connect block.
  try {
    if (await hasConnectRail(issuerDid)) return { kind: 'connect' };
  } catch (error) {
    log.error({ err: String(error), issuerDid }, 'card rail: Connect lookup failed — treating as unavailable');
  }

  return { kind: 'none' };
}

/** #2757: the destination account and application fee for a Connect checkout — what the pre-#2754 checkout always did. */
export async function resolveConnectCheckout(body: CheckoutBody) {
  return resolveConnectedAccountFee(body);
}
