/**
 * Unit tests for the pure helper functions extracted from ticket-purchase.tsx
 * while reducing its cognitive complexity (#2067 / S3776). These are simple
 * guard predicates and lookup-style functions, so they're covered here
 * directly rather than via a full component render.
 */
import { describe, it, expect } from 'vitest';
import type { TicketType } from '@/src/db/schema';
import {
  computeAvailableCount,
  isSoldOut,
  computeEffectiveMax,
  resolveTriState,
  resolvePrimaryAction,
  mainCtaLabel,
} from '../ticket-purchase';

function fakeTicket(overrides: Partial<TicketType>): TicketType {
  return {
    id: 'tkt_type_1',
    eventId: 'evt_1',
    name: 'General Admission',
    description: null,
    price: 1000,
    currency: 'CAD',
    quantity: null,
    sold: 0,
    perks: [],
    metadata: {},
    sortOrder: 0,
    requiresRegistration: false,
    registrationFormId: null,
    maxPerOrder: null,
    accessCode: null,
    createdAt: null,
    ...overrides,
  };
}

describe('computeAvailableCount', () => {
  it('returns null when the ticket type has unlimited quantity', () => {
    expect(computeAvailableCount({ quantity: null, sold: 5 })).toBeNull();
  });

  it('returns the remaining quantity when sold is set', () => {
    expect(computeAvailableCount({ quantity: 10, sold: 4 })).toBe(6);
  });

  it('treats a missing sold count as zero', () => {
    expect(computeAvailableCount({ quantity: 10, sold: null })).toBe(10);
  });
});

describe('isSoldOut', () => {
  it('is never sold out when quantity is unlimited', () => {
    expect(isSoldOut({ quantity: null, sold: 1000 })).toBe(false);
  });

  it('is sold out once sold reaches quantity', () => {
    expect(isSoldOut({ quantity: 5, sold: 5 })).toBe(true);
  });

  it('is not sold out while sold is below quantity', () => {
    expect(isSoldOut({ quantity: 5, sold: 4 })).toBe(false);
  });
});

describe('computeEffectiveMax', () => {
  it('caps at 20 even when maxPerOrder is higher', () => {
    expect(computeEffectiveMax(fakeTicket({ quantity: null, sold: 0 }), 50)).toBe(20);
  });

  it('falls back to the ticket-type maxPerOrder when no prop override is given', () => {
    expect(computeEffectiveMax(fakeTicket({ quantity: null, sold: 0, maxPerOrder: 3 }), undefined)).toBe(3);
  });

  it('defaults to 10 when nothing else is set', () => {
    expect(computeEffectiveMax(fakeTicket({ quantity: null, sold: 0 }), undefined)).toBe(10);
  });

  it('is bounded by remaining availability', () => {
    expect(computeEffectiveMax(fakeTicket({ quantity: 5, sold: 3 }), 10)).toBe(2);
  });
});

describe('resolveTriState', () => {
  it('prioritizes loading over disabled', () => {
    expect(resolveTriState(true, true)).toBe('loading');
  });

  it('is disabled when not loading but disabled', () => {
    expect(resolveTriState(false, true)).toBe('disabled');
  });

  it('is active when neither loading nor disabled', () => {
    expect(resolveTriState(false, false)).toBe('active');
  });
});

describe('resolvePrimaryAction', () => {
  it('prefers RSVP for free tickets regardless of other flags', () => {
    expect(resolvePrimaryAction(true, true, true)).toBe('rsvp');
  });

  it('routes straight to e-Transfer when Stripe is disabled', () => {
    expect(resolvePrimaryAction(false, true, true)).toBe('etransfer');
  });

  it('shows the selector when e-Transfer is available alongside Stripe', () => {
    expect(resolvePrimaryAction(false, false, true)).toBe('selector');
  });

  it('defaults to card payment', () => {
    expect(resolvePrimaryAction(false, false, false)).toBe('card');
  });
});

describe('mainCtaLabel', () => {
  it('shows a confirming state while RSVP is loading', () => {
    expect(mainCtaLabel('loading-rsvp', true, false, false, 1)).toBe('Confirming...');
  });

  it('labels free tickets as RSVP', () => {
    expect(mainCtaLabel('button', true, false, false, 1)).toBe('RSVP');
  });

  it('labels e-Transfer-only checkout', () => {
    expect(mainCtaLabel('button', false, true, true, 1)).toBe('🏦 Pay by e-Transfer');
  });

  it('pluralizes the ticket count', () => {
    expect(mainCtaLabel('button', false, false, false, 3)).toBe('Get 3 Tickets');
  });

  it('prompts for quantity selection when zero', () => {
    expect(mainCtaLabel('button', false, false, false, 0)).toBe('Select quantity');
  });

  it('defaults to a singular ticket label', () => {
    expect(mainCtaLabel('button', false, false, false, 1)).toBe('Get Ticket');
  });
});
