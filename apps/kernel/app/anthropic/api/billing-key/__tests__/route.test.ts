import { describe } from 'vitest';
import {
  mockRouteWiringFactories,
  mockBillingKeyConnector,
  describeBillingKeyRouteWiringContract,
} from '@/src/lib/kernel/__tests__/brain-connector-contract';

const { tokenOpts } = mockRouteWiringFactories();
const { sealBillingKey, billingKeySealed } = mockBillingKeyConnector('@/src/lib/anthropic/billing-connector');

const route = await import('../route');

describe('anthropic billing-key route wiring', () => {
  describeBillingKeyRouteWiringContract({
    label: 'Anthropic Billing',
    tokenOpts,
    route,
    sealBillingKey,
    billingKeySealed,
  });
});
