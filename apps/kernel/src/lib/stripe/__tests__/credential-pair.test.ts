import { describe, it, expect } from 'vitest';
import { StripeCredentialError, validateStripeCredentialPair } from '../credential-pair';

describe('validateStripeCredentialPair', () => {
  it.each(['test', 'live'])('accepts a matching %s pair with surrounding whitespace', (mode) => {
    expect(() => validateStripeCredentialPair(` rk_${mode}_fake `, ` pk_${mode}_fake `)).not.toThrow();
  });

  it.each([
    ['', 'pk_test_fake', 'stripe_key_missing', 'token'],
    ['  ', 'pk_test_fake', 'stripe_key_missing', 'token'],
    ['sk_test_fake', 'pk_test_fake', 'stripe_key_not_restricted', 'token'],
    ['rk_fake', 'pk_test_fake', 'stripe_key_not_restricted', 'token'],
    ['rk_test_', 'pk_test_fake', 'stripe_key_not_restricted', 'token'],
    ['rk_invalid_fake', 'pk_test_fake', 'stripe_key_not_restricted', 'token'],
    ['rk_test_fake', undefined, 'stripe_publishable_key_missing', 'publishableKey'],
    ['rk_test_fake', '', 'stripe_publishable_key_missing', 'publishableKey'],
    ['rk_test_fake', '  ', 'stripe_publishable_key_missing', 'publishableKey'],
    ['rk_test_fake', 'rk_test_fake', 'stripe_publishable_key_invalid', 'publishableKey'],
    ['rk_test_fake', 'pk_fake', 'stripe_publishable_key_invalid', 'publishableKey'],
    ['rk_test_fake', 'pk_test_', 'stripe_publishable_key_invalid', 'publishableKey'],
    ['rk_test_fake', 'pk_invalid_fake', 'stripe_publishable_key_invalid', 'publishableKey'],
    ['rk_test_fake', 'pk_live_fake', 'stripe_key_mode_mismatch', 'publishableKey'],
    ['rk_live_fake', 'pk_test_fake', 'stripe_key_mode_mismatch', 'publishableKey'],
  ])('rejects invalid pair %# with a field-specific safe error', (token, publishableKey, code, field) => {
    let failure: unknown;
    try {
      validateStripeCredentialPair(token!, publishableKey);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(StripeCredentialError);
    expect(failure).toMatchObject({ name: 'StripeCredentialError', code, field });
    const message = (failure as Error).message;
    expect(message).not.toContain('fake');
    expect(message).toContain(field!);
  });
});
