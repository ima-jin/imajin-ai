import { describe, it } from 'vitest';
import {
  mockRouteWiringFactories,
  mockBillingKeyConnector,
  describeBillingKeyRouteWiringContract,
  expectNoDisconnectRouteWired,
} from '@/src/lib/kernel/__tests__/brain-connector-contract';

const { tokenOpts, disconnectOpts } = mockRouteWiringFactories();
const { sealBillingKey, billingKeySealed } = mockBillingKeyConnector('@/src/lib/openai/billing-connector');

const route = await import('../route');

describe('openai billing-key route wiring', () => {
  // Direct, literal it() (see expectNoDisconnectRouteWired's doc comment)
  // so this file itself is recognized by Sonar S2187.
  it('does not wire a disconnect route for this Stage 1 billing credential', () =>
    expectNoDisconnectRouteWired(disconnectOpts));

  describeBillingKeyRouteWiringContract({
    label: 'OpenAI Billing',
    tokenOpts,
    route,
    sealBillingKey,
    billingKeySealed,
  });
});
