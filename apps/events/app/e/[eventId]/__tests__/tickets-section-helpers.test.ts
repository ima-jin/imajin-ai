/**
 * Pure-function unit tests for helpers extracted from tickets-section.tsx
 * while reducing sonarjs/cognitive-complexity (#2067) in
 * `handleRegistrationComplete`, `UnifiedCheckoutBar`, and its polling effect.
 */
import { describe, it, expect } from 'vitest';
import {
  registrationBackoffMs,
  verifyStatusHeading,
  cardButtonLabel,
  computePendingRegistrationCount,
} from '../tickets-section';
import type { TicketType } from '@/src/db/schema';

describe('registrationBackoffMs', () => {
  it('doubles the backoff with each attempt', () => {
    expect(registrationBackoffMs(1)).toBe(500);
    expect(registrationBackoffMs(2)).toBe(1000);
    expect(registrationBackoffMs(3)).toBe(2000);
  });
});

describe('verifyStatusHeading', () => {
  it('prioritizes the expired state', () => {
    expect(verifyStatusHeading(true, true)).toBe('Verification expired');
  });

  it('shows the polling message when not expired but still polling', () => {
    expect(verifyStatusHeading(false, true)).toBe('Waiting for verification…');
  });

  it('falls back to the initial check-your-email message', () => {
    expect(verifyStatusHeading(false, false)).toBe('Check your email to confirm');
  });
});

describe('cardButtonLabel', () => {
  it('shows a loading label while the card checkout is in flight', () => {
    expect(cardButtonLabel('card-loading', 2, '$20.00')).toBe('Loading…');
  });

  it('shows a plain label when the cart is empty', () => {
    expect(cardButtonLabel('idle', 0, '$0.00')).toBe('💳 Pay with Card');
  });

  it('includes the formatted total once the cart has items', () => {
    expect(cardButtonLabel('idle', 2, '$20.00')).toBe('💳 Pay with Card — $20.00');
  });
});

describe('computePendingRegistrationCount', () => {
  const ticket = (overrides: Partial<TicketType> = {}) =>
    ({ id: 't1', requiresRegistration: false, ...overrides }) as TicketType;

  it('returns 0 when nothing is pending', () => {
    expect(computePendingRegistrationCount([], [])).toBe(0);
  });

  it('counts pending registrations across existing user orders', () => {
    const userOrders = [
      {
        id: 'o1',
        isLegacy: false,
        quantity: 2,
        totalAmount: 1000,
        currency: 'CAD',
        purchasedAt: null,
        ticketTypeName: 'GA',
        fairSettlement: null,
        tickets: [
          { id: 'tk1', status: 'valid', usedAt: null, registrationStatus: 'pending', pricePaid: 500, currency: 'CAD', ticketType: { name: 'GA', description: null, perks: null, registrationFormId: 'form1' } },
          { id: 'tk2', status: 'valid', usedAt: null, registrationStatus: 'complete', pricePaid: 500, currency: 'CAD', ticketType: { name: 'GA', description: null, perks: null, registrationFormId: 'form1' } },
        ],
      },
    ] as unknown as Parameters<typeof computePendingRegistrationCount>[0];

    expect(computePendingRegistrationCount(userOrders, [])).toBe(1);
  });

  it('adds cart items that require registration', () => {
    const cartItems = [
      { ticket: ticket({ requiresRegistration: true }), qty: 3 },
      { ticket: ticket({ requiresRegistration: false }), qty: 5 },
    ];

    expect(computePendingRegistrationCount([], cartItems)).toBe(3);
  });
});
