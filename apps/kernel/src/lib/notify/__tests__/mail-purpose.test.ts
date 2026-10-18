import { describe, expect, it } from 'vitest';
import { notificationMailPurpose } from '../mail-purpose';

describe('kernel notification purpose vocabulary', () => {
  it.each([
    'event:ticket-receipt', 'market:purchase', 'coffee:tip-sent',
    'pay:payment_request-paid', 'pay:payment_request-settled',
  ])('classifies the fixed receipt scope %s', (scope) => {
    expect(notificationMailPurpose(scope)).toBe('receipts');
  });
  it.each([
    'pay:payment_request-issued', 'pay:payment_request-voided', 'pay:payment_request-claimed',
    'event:ticket-confirmed', 'pay:made-up-receipt', 'receipts', 'signin', 'contact',
    'pay:payment_request-paid:spoof', '', 'attest.pending_signature',
  ])('does not allow arbitrary scopes/purposes to select receipt or signin senders: %s', (scope) => {
    expect(notificationMailPurpose(scope)).toBe('notifications');
  });
});
