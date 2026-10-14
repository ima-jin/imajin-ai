import { stripe, stripePublishableKeyField } from '@/src/lib/stripe/connector-core';
import { loadAndUnseal } from '@/src/lib/vault';
import { resolveCardRail, SELLER_NO_CARD_RAIL } from '../payment-requests/card-rail';

export class SellerNoCardRailError extends Error {
  readonly code = SELLER_NO_CARD_RAIL;

  constructor() {
    super("This seller hasn't set up card payments");
    this.name = 'SellerNoCardRailError';
  }
}

/** Resolve one transacting DID's connector. Never consult node credentials or cache key material. */
export async function resolveDidStripeKeys(did: string): Promise<{
  secretKey: string;
  publishableKey: string | undefined;
}> {
  if (!did || !did.startsWith('did:')) throw new SellerNoCardRailError();
  const rail = await resolveCardRail(did);
  if (rail.kind === 'none') throw new SellerNoCardRailError();
  const credentials = await stripe.loadSealedCredentials(rail.ownerDid);
  if (!credentials?.apiKey) throw new SellerNoCardRailError();
  const publishableKey = await loadAndUnseal(stripePublishableKeyField(rail.ownerDid));
  return { secretKey: credentials.apiKey, publishableKey };
}
