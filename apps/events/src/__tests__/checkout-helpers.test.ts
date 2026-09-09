/**
 * Tests for pure helpers in src/lib/checkout-helpers.ts.
 * Extracted from app/api/checkout/route.ts during the S3776 cognitive-complexity
 * cleanup (#2067) — covers the new buildStripeCheckoutItems() lookup/mapping helper.
 */
import { describe, it, expect } from 'vitest';
import { buildStripeCheckoutItems } from '../lib/checkout-helpers';

describe('buildStripeCheckoutItems', () => {
  const typesById = new Map([
    ['tt_ga', { name: 'General Admission', description: 'Standing room', price: 2500 }],
    ['tt_vip', { name: 'VIP', description: null, price: 10000 }],
  ]);

  it('maps each cart item to a named, priced line item using the type description', () => {
    const items = buildStripeCheckoutItems(
      [{ ticketTypeId: 'tt_ga', quantity: 2 }],
      typesById,
      'Summer Fair',
    );

    expect(items).toEqual([
      { name: 'Summer Fair — General Admission', description: 'Standing room', amount: 2500, quantity: 2 },
    ]);
  });

  it('falls back to an undefined description when the ticket type has none', () => {
    const items = buildStripeCheckoutItems(
      [{ ticketTypeId: 'tt_vip', quantity: 1 }],
      typesById,
      'Summer Fair',
    );

    expect(items[0].description).toBeUndefined();
  });

  it('builds one line item per cart entry, preserving order', () => {
    const items = buildStripeCheckoutItems(
      [
        { ticketTypeId: 'tt_ga', quantity: 3 },
        { ticketTypeId: 'tt_vip', quantity: 1 },
      ],
      typesById,
      'Summer Fair',
    );

    expect(items.map((i) => i.name)).toEqual(['Summer Fair — General Admission', 'Summer Fair — VIP']);
    expect(items.map((i) => i.quantity)).toEqual([3, 1]);
  });
});
