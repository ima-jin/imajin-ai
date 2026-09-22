/**
 * Type-leak guard (#2175): the pay webhook route, the connect webhook
 * route, and `webhook-handlers.ts` must never import the `stripe` SDK
 * directly — every Stripe SDK access lives behind
 * `lib/pay/providers/stripe-webhook.ts` (and `providers/stripe-client.ts`).
 *
 * Mirrors the check `scripts/ci-guard-stripe-import-scope.mjs` runs across
 * the whole `lib/pay/` / `app/pay/` tree, scoped here to the three files
 * this change specifically migrated off a direct `stripe` import.
 *
 * Also imports the route module itself (with the same minimal mocks
 * `transfer-created.test.ts` uses) to confirm it loads standalone without
 * needing the real `stripe` package to be present/mocked at all.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const STRIPE_IMPORT_RE = /from\s+['"]stripe['"]|require\(\s*['"]stripe['"]\s*\)/;

function readSource(relativeUrl: string): string {
  return readFileSync(fileURLToPath(new URL(relativeUrl, import.meta.url)), 'utf8');
}

vi.mock('@/src/db', () => ({ db: {}, transactions: {}, feeLedger: {} }));
vi.mock('@imajin/bus', () => ({ publish: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/src/lib/kernel/id', () => ({ generateId: (prefix: string) => `${prefix}_test` }));
vi.mock('@/src/lib/pay/payment-requests/checkout', () => ({
  settlePaymentRequestFromStripeCheckout: vi.fn(),
}));

describe('type-leak guard: pay webhook ingress never imports the stripe SDK directly (#2175)', () => {
  it('the pay webhook route source has no stripe import', () => {
    expect(readSource('../route.ts')).not.toMatch(STRIPE_IMPORT_RE);
  });

  it('the connect webhook route source has no stripe import', () => {
    expect(readSource('../../connect/webhook/route.ts')).not.toMatch(STRIPE_IMPORT_RE);
  });

  it('webhook-handlers.ts source has no stripe import', () => {
    expect(readSource('../../../../../src/lib/pay/webhook-handlers.ts')).not.toMatch(STRIPE_IMPORT_RE);
  });

  it('importing the pay webhook route module succeeds without STRIPE_SECRET_KEY/webhook secrets configured', async () => {
    const routeModule = await import('../route');
    expect(routeModule.POST).toBeTypeOf('function');
  });
});
