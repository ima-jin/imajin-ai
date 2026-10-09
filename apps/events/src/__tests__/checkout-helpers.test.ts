/**
 * Tests for pure helpers in src/lib/checkout-helpers.ts.
 * Extracted from app/api/checkout/route.ts during the S3776 cognitive-complexity
 * cleanup (#2067) — covers the new buildStripeCheckoutItems() lookup/mapping helper.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildStripeCheckoutItems,
  requestPayCheckoutSession,
  NO_CARD_RAIL_MESSAGE,
  SELLER_NO_CARD_RAIL,
} from '../lib/checkout-helpers';

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

describe('requestPayCheckoutSession (#2757: no card rail is a plain 400, not a server fault)', () => {
  const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
  const params = {
    payServiceUrl: 'https://kernel.test/pay',
    items: [{ name: 'Ticket', amount: 2500, quantity: 1 }],
    currency: 'CAD',
    successUrl: 'https://events.test/ok',
    cancelUrl: 'https://events.test/cancel',
    fairManifest: null,
    sellerDid: 'did:imajin:organizer',
    metadata: { service: 'events' },
    log,
  } as unknown as Parameters<typeof requestPayCheckoutSession>[0];

  afterEach(() => {
    vi.unstubAllGlobals();
    log.error.mockReset();
  });

  function stubPay(response: { ok: boolean; body?: unknown; jsonThrows?: boolean }) {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: response.ok,
      json: async () => {
        if (response.jsonThrows) throw new Error('not json');
        return response.body;
      },
    })));
  }

  it('returns the session when the pay service creates one', async () => {
    stubPay({ ok: true, body: { id: 'cs_1', url: 'https://checkout.stripe.com/cs_1' } });

    expect(await requestPayCheckoutSession(params)).toEqual({ checkout: { id: 'cs_1', url: 'https://checkout.stripe.com/cs_1' } });
  });

  it('maps SELLER_NO_CARD_RAIL to a plain 400 the buyer can read, and does not log it as a pay-service fault', async () => {
    stubPay({ ok: false, body: { error: "This seller hasn't set up card payments", code: 'SELLER_NO_CARD_RAIL' } });

    expect(await requestPayCheckoutSession(params)).toEqual({
      error: NO_CARD_RAIL_MESSAGE,
      status: 400,
      code: SELLER_NO_CARD_RAIL,
    });
    expect(log.error).not.toHaveBeenCalled();
  });

  it('keeps every other pay-service failure a logged 500', async () => {
    stubPay({ ok: false, body: { error: 'Card payment could not be started', code: 'CARD_RAIL_KEY_REJECTED' } });

    expect(await requestPayCheckoutSession(params)).toEqual({ error: 'Card payment could not be started', status: 500 });
    expect(log.error).toHaveBeenCalledOnce();
  });

  it('survives a non-JSON failure body', async () => {
    stubPay({ ok: false, jsonThrows: true });

    expect(await requestPayCheckoutSession(params)).toEqual({ error: 'Payment service error', status: 500 });
  });
});
