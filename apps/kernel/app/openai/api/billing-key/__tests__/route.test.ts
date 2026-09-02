import { describe, it, expect, vi } from 'vitest';
import { mockRouteWiringFactories } from '@/src/lib/kernel/__tests__/brain-connector-contract';

const { sealBillingKey, billingKeySealed } = vi.hoisted(() => ({
  sealBillingKey: Symbol('sealBillingKey'),
  billingKeySealed: Symbol('billingKeySealed'),
}));

const { tokenOpts } = mockRouteWiringFactories();

vi.mock('@/src/lib/openai/billing-connector', () => ({
  sealBillingKey,
  billingKeySealed,
}));

const route = await import('../route');

describe('openai billing-key route wiring', () => {
  it('seals through the OpenAI Billing connector, and nothing else', () => {
    expect(tokenOpts.current).toMatchObject({ name: 'OpenAI Billing' });
    expect(tokenOpts.current?.sealApiKey).toBe(sealBillingKey);
    expect(tokenOpts.current?.keySealed).toBe(billingKeySealed);
  });

  it('exports the full credential lifecycle (no disconnect/manifest routes for Stage 1)', () => {
    expect(route.GET).toBeDefined();
    expect(route.POST).toBeDefined();
    expect(route.OPTIONS).toBeDefined();
  });
});
