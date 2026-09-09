/**
 * Tests for pure helpers in src/lib/balance-checkout-helpers.ts.
 * Extracted from app/api/checkout/balance/route.ts during the S3776
 * cognitive-complexity cleanup (#2067) — covers the normalizeBalanceCart()
 * parse/coalesce/clamp guard logic.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Logger } from '@imajin/logger';
import { normalizeBalanceCart, transferBuyerBalance } from '../lib/balance-checkout-helpers';

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

/**
 * Contract test (#2002): `transferBuyerBalance` must call the kernel pay
 * service at the path pay.yaml actually documents. `payServiceUrl` already
 * includes the `/pay` prefix (same convention as `requestPayCheckoutSession`
 * and every other cross-service call in this app) — this call site used to
 * hardcode a duplicated `/pay` segment that pay.yaml never documented.
 */
describe('transferBuyerBalance', () => {
  const log: Logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  };
  const fetchMock = vi.fn();
  const baseParams = {
    payServiceUrl: 'http://localhost:3000/pay',
    cookieHeader: 'imajin_session=abc',
    fromDid: 'did:imajin:buyer',
    toDid: 'did:imajin:creator',
    amountCents: 1000,
    eventId: 'evt_1',
    cart: [{ ticketTypeId: 'tt_1', quantity: 1 }],
    log,
  };

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ transactionId: 'tx_1' }),
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('targets the documented /api/balance/transfer path, not a duplicated /pay prefix', async () => {
    await transferBuyerBalance(baseParams);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:3000/pay/api/balance/transfer');
    expect(url).not.toContain('/pay/pay/');
  });

  it('forwards the caller session as a Cookie header (session auth, not an internal key)', async () => {
    await transferBuyerBalance(baseParams);

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Cookie).toBe('imajin_session=abc');
    expect(init.headers.Authorization).toBeUndefined();
  });
});
