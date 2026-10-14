import Stripe from 'stripe';
import { getNodeDid } from '@/src/lib/kernel/node-identity';
import { resolveDidStripeKeys, SellerNoCardRailError } from '../rails/stripe-keys';

export class NodeCardRailNotConfiguredError extends Error {
  readonly code = 'NODE_CARD_RAIL_NOT_CONFIGURED';

  constructor() {
    super('Card rail not configured for this node');
    this.name = 'NodeCardRailNotConfiguredError';
  }
}

/** No startup lookup or cached key: revoking the node's connector takes effect on the next call. */
export async function getNodeStripeClient(): Promise<{ nodeDid: string; stripe: Stripe }> {
  const nodeDid = await getNodeDid();
  if (!nodeDid) throw new NodeCardRailNotConfiguredError();
  try {
    const { secretKey } = await resolveDidStripeKeys(nodeDid);
    return { nodeDid, stripe: new Stripe(secretKey) };
  } catch (error) {
    if (error instanceof SellerNoCardRailError) throw new NodeCardRailNotConfiguredError();
    throw error;
  }
}
