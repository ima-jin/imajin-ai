/**
 * Stripe connector identity + sealed-credential factory (#1785, #2754).
 *
 * A leaf module on purpose: `connector.ts` pulls in the bus and the pay
 * `pay-stripe` reactor, and the pay layer (rail selection, BYO checkout)
 * needs to read the owner's sealed restricted key. Importing `connector.ts`
 * from there would close an import cycle (`connector` -> `stripe-bus-consumer`
 * -> `payment-requests/*` -> `connector`). Both sides import from here
 * instead, so there is exactly ONE token-paste factory instance and one
 * definition of the connector identity.
 */
import {
  createConnectorTokenPaste,
  type TokenPasteCredentials,
} from '@/src/lib/kernel/connector-token-paste';

/** Connector app DID — the selectable "Stripe" connector identity. */
export const STRIPE_CONNECTOR_DID = 'did:imajin:stripe-connector';

/** Scope gating whether verified events get republished onto the owner's bus. */
export const STRIPE_EVENTS_SCOPE = 'stripe:events';

export const stripe = createConnectorTokenPaste({
  id: 'stripe',
  displayName: 'Stripe',
  connectorDid: STRIPE_CONNECTOR_DID,
  channel: 'stripe',
});

export type StripeCredentials = TokenPasteCredentials;
