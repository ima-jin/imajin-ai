import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const kernel = resolve(__dirname, '../../../..');
const routes = ['checkout', 'charge', 'charge-pledges', 'setup-intent', 'escrow', 'refund'];
const helpers = [
  'src/lib/pay/rails/stripe-keys.ts',
  'src/lib/pay/hosted-checkout.ts',
  'src/lib/pay/app-pledges.ts',
  'src/lib/pay/refund.ts',
  'src/lib/pay/providers/seller-stripe-payments.ts',
  'src/lib/pay/providers/seller-pledge-refund.ts',
  'src/lib/stripe/byo-checkout.ts',
  'src/lib/stripe/byo-setup-intent.ts',
  'src/lib/pay/setup-intent-route.ts',
];

describe('seller card paths never read node Stripe credentials', () => {
  it.each([...routes.map((route) => `app/pay/api/${route}/route.ts`), ...helpers])(
    '%s has no environment key read or platform singleton call',
    (path) => {
      const source = readFileSync(resolve(kernel, path), 'utf8');
      expect(source).not.toMatch(/process\.env(?:\.STRIPE_(?:SECRET|PUBLISHABLE)_KEY|\[['"]STRIPE_(?:SECRET|PUBLISHABLE)_KEY['"]\])/);
      expect(source).not.toMatch(/\b(?:getStripeClient|getPaymentService|getStripePublishableKey)\s*\(/);
      expect(source).not.toMatch(/from ['"][^'"]*(?:providers\/stripe-client|\/pay\/pay)['"]/);
    },
  );
  it('all seller account operations use the one shared sealed key resolver', () => {
    for (const path of [
      'app/pay/api/charge/route.ts', 'app/pay/api/escrow/route.ts',
      'src/lib/stripe/byo-setup-intent.ts', 'src/lib/pay/app-pledges.ts',
      'src/lib/pay/refund.ts', 'src/lib/stripe/byo-checkout.ts',
    ]) {
      expect(readFileSync(resolve(kernel, path), 'utf8')).toContain('resolveDidStripeKeys');
    }
  });
  it('pledge collection has no kernel pledge row or events API dependency', () => {
    const source = readFileSync(resolve(kernel, 'src/lib/pay/app-pledges.ts'), 'utf8');
    expect(source).not.toMatch(/@\/src\/db|\.select\(|\.insert\(|\.update\(transactions|events\/api|buildPublicUrl/);
  });
});
