
export class SellerNoCardRailError extends Error {
  readonly code = 'SELLER_NO_CARD_RAIL';

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
  // Enumerating other rails must not initialize the Stripe connector or vault.
  const { resolveCardRail } = await import('../payment-requests/card-rail');
  const rail = await resolveCardRail(did);
  if (rail.kind === 'none') throw new SellerNoCardRailError();
  const { stripe, stripePublishableKeyField } = await import('@/src/lib/stripe/connector-core');
  const credentials = await stripe.loadSealedCredentials(rail.ownerDid);
  if (!credentials?.apiKey) throw new SellerNoCardRailError();
  const { loadAndUnseal } = await import('@/src/lib/vault');
  const publishableKey = await loadAndUnseal(stripePublishableKeyField(rail.ownerDid));
  return { secretKey: credentials.apiKey, publishableKey };
}
