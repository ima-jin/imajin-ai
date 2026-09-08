import { describe, it, expect } from 'vitest';
import {
  mockRouteWiringFactories,
  mockBillingKeyConnector,
  describeBillingKeyRouteWiringContract,
} from '@/src/lib/kernel/__tests__/brain-connector-contract';

const { tokenOpts, disconnectOpts } = mockRouteWiringFactories();
const { sealBillingKey, billingKeySealed } = mockBillingKeyConnector('@/src/lib/anthropic/billing-connector');

const route = await import('../route');

describe('anthropic billing-key route wiring', () => {
  // Direct, literal assertion (rather than only delegating to the shared
  // contract below) so this file itself is recognized as containing test
  // cases. See the module doc comment on brain-connector-contract.ts. Also a
  // real guard on this route's documented design (route.ts: "There is no
  // raw-key release path" / Stage 1 has no disconnect route): importing
  // ../route must never reach for the disconnect factory.
  it('does not wire a disconnect route for this Stage 1 billing credential', () => {
    expect(disconnectOpts.current).toBeNull();
  });

  describeBillingKeyRouteWiringContract({
    label: 'Anthropic Billing',
    tokenOpts,
    route,
    sealBillingKey,
    billingKeySealed,
  });
});
