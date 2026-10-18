import { describe, expect, it } from 'vitest';
import { mailDeliveryFailure } from '../mail-delivery-error';

describe('safe mail delivery failure projection', () => {
  it('exposes only the exact kernel post-delivery audit outcome', () => {
    expect(mailDeliveryFailure('mail_audit_failed_after_delivery_do_not_retry', 'Mail failed')).toEqual({
      error: 'mail_audit_failed_after_delivery_do_not_retry', retryable: false, deliveredMayHaveOccurred: true,
    });
  });
  it.each([
    undefined, null, 123, new Error('provider-private-fixture'), { error: 'provider-private-fixture' },
    'provider-private-fixture', 'mail_audit_failed_after_delivery_do_not_retry:private-suffix',
  ])('redacts ordinary/malformed provider details without asserting delivery state (%s)', (error) => {
    expect(mailDeliveryFailure(error, 'Mail failed')).toEqual({ error: 'Mail failed' });
  });
});
