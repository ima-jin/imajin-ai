import { describe, it, expect } from 'vitest';
import {
  mockRouteWiringFactories,
  mockBillingKeyConnector,
  describeBillingKeyRouteWiringContract,
  expectNoDisconnectRouteWired,
} from '@/src/lib/kernel/__tests__/brain-connector-contract';

const { tokenOpts, disconnectOpts } = mockRouteWiringFactories();
const { sealBillingKey, billingKeySealed } = mockBillingKeyConnector('@/src/lib/anthropic/billing-connector');

const route = await import('../route');

describe('anthropic billing-key route wiring', () => {
  // Direct, literal it() with a literal expect() on the helper's return
  // value (see expectNoDisconnectRouteWired's doc comment) so Sonar S2699
  // recognizes this file as containing a real assertion.
  it('does not wire a disconnect route for this Stage 1 billing credential', () => {
    expect(expectNoDisconnectRouteWired(disconnectOpts)).toBe(true);
  });

  describeBillingKeyRouteWiringContract({
    label: 'Anthropic Billing',
    tokenOpts,
    route,
    sealBillingKey,
    billingKeySealed,
  });
});
