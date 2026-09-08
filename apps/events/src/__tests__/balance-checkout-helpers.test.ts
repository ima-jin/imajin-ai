/**
 * Tests for pure helpers in src/lib/balance-checkout-helpers.ts.
 * Extracted from app/api/checkout/balance/route.ts during the S3776
 * cognitive-complexity cleanup (#2067) — covers the normalizeBalanceCart()
 * parse/coalesce/clamp guard logic.
 */
import { describe, it, expect } from 'vitest';
import { normalizeBalanceCart } from '../lib/balance-checkout-helpers';

describe('normalizeBalanceCart', () => {
  it('returns an error descriptor when neither items nor ticketTypeId is provided', () => {
    const result = normalizeBalanceCart({});
    expect(result).toEqual({ error: 'items or ticketTypeId is required', status: 400 });
  });

  it('normalizes the legacy single ticketTypeId + quantity shape', () => {
    const result = normalizeBalanceCart({ ticketTypeId: 'tt_1', quantity: 3 });
    expect(result).toEqual([{ ticketTypeId: 'tt_1', quantity: 3 }]);
  });

  it('defaults quantity to 1 when omitted for the legacy shape', () => {
    const result = normalizeBalanceCart({ ticketTypeId: 'tt_1' });
    expect(result).toEqual([{ ticketTypeId: 'tt_1', quantity: 1 }]);
  });

  it('coalesces duplicate ticket type ids in the items array by summing quantities', () => {
    const result = normalizeBalanceCart({
      items: [
        { ticketTypeId: 'tt_1', quantity: 2 },
        { ticketTypeId: 'tt_1', quantity: 3 },
        { ticketTypeId: 'tt_2', quantity: 1 },
      ],
    });

    expect(result).toEqual([
      { ticketTypeId: 'tt_1', quantity: 5 },
      { ticketTypeId: 'tt_2', quantity: 1 },
    ]);
  });

  it('clamps quantities to the maximum of 20 per ticket type', () => {
    const result = normalizeBalanceCart({ items: [{ ticketTypeId: 'tt_1', quantity: 999 }] });
    expect(result).toEqual([{ ticketTypeId: 'tt_1', quantity: 20 }]);
  });

  it('floors fractional quantities and enforces a minimum of 1', () => {
    const result = normalizeBalanceCart({ items: [{ ticketTypeId: 'tt_1', quantity: 0.4 }] });
    expect(result).toEqual([{ ticketTypeId: 'tt_1', quantity: 1 }]);
  });

  it('skips items missing a ticketTypeId', () => {
    const result = normalizeBalanceCart({
      items: [{ ticketTypeId: '', quantity: 2 }, { ticketTypeId: 'tt_1', quantity: 1 }],
    });
    expect(result).toEqual([{ ticketTypeId: 'tt_1', quantity: 1 }]);
  });
});
