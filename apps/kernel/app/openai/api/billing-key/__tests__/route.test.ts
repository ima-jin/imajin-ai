import { describe } from 'vitest';
import {
  mockRouteWiringFactories,
  mockBillingKeyConnector,
  describeBillingKeyRouteWiringContract,
} from '@/src/lib/kernel/__tests__/brain-connector-contract';

const { tokenOpts } = mockRouteWiringFactories();
const { sealBillingKey, billingKeySealed } = mockBillingKeyConnector('@/src/lib/openai/billing-connector');

const route = await import('../route');

describe('openai billing-key route wiring', () => {
  describeBillingKeyRouteWiringContract({
    label: 'OpenAI Billing',
    tokenOpts,
    route,
    sealBillingKey,
    billingKeySealed,
  });
});
