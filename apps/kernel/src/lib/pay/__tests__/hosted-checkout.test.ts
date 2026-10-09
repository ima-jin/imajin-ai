/**
 * #2757: the hosted checkout starts on the seller's OWN Stripe account (BYO
 * connector) or not at all — no Connect, no platform-held fallback. A checkout
 * that names no seller stays a platform-own charge.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  resolveCardRailMock: vi.fn(),
  createByoSessionMock: vi.fn(),
  platformCheckoutMock: vi.fn(),
  errorMock: vi.fn(),
}));

vi.mock('../payment-requests/card-rail', () => ({
  resolveCardRail: h.resolveCardRailMock,
  SELLER_NO_CARD_RAIL: 'SELLER_NO_CARD_RAIL',
}));
vi.mock('@/src/lib/stripe/byo-checkout', () => {
  class ByoCheckoutError extends Error {
    readonly code: string;
    readonly stripeStatus: number | undefined;
    constructor(code: string, message: string, stripeStatus?: number) {
      super(message);
      this.code = code;
      this.stripeStatus = stripeStatus;
    }
  }
  return { ByoCheckoutError, createByoCheckoutSession: h.createByoSessionMock };
});
vi.mock('../pay', () => ({ getPaymentService: () => ({ checkout: h.platformCheckoutMock }) }));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: h.errorMock }) }));

import { ByoCheckoutError } from '@/src/lib/stripe/byo-checkout';
import { sellerDidOf, startHostedCheckout, type StartHostedCheckoutInput } from '../hosted-checkout';

const SELLER = 'did:imajin:organizer';
const SESSION = { id: 'cs_1', url: 'https://checkout.stripe.com/cs_1', expiresAt: new Date('2026-01-02T00:00:00Z') };

function input(bodyOverrides: Record<string, unknown> = {}): StartHostedCheckoutInput {
  return {
    body: {
      items: [{ name: 'Ticket', amount: 2500, quantity: 1 }],
      currency: 'CAD',
      successUrl: 'https://events.test/ok',
      cancelUrl: 'https://events.test/cancel',
      customerEmail: 'buyer@example.com',
      sellerDid: SELLER,
      ...bodyOverrides,
    } as StartHostedCheckoutInput['body'],
    items: [{ name: 'Ticket', amount: 2500, quantity: 1 }],
    metadata: { service: 'events', eventId: 'ev_1' },
    transactionId: 'tx_1',
  };
}

beforeEach(() => {
  h.resolveCardRailMock.mockReset().mockResolvedValue({ kind: 'connector', ownerDid: SELLER });
  h.createByoSessionMock.mockReset().mockResolvedValue(SESSION);
  h.platformCheckoutMock.mockReset().mockResolvedValue(SESSION);
  h.errorMock.mockReset();
});

describe('sellerDidOf', () => {
  it('reads the seller from the body, falling back to metadata.sellerDid (market names it there)', () => {
    expect(sellerDidOf({ sellerDid: SELLER } as never)).toBe(SELLER);
    expect(sellerDidOf({ metadata: { sellerDid: 'did:imajin:m' } } as never)).toBe('did:imajin:m');
    expect(sellerDidOf({} as never)).toBeUndefined();
  });
});

describe('startHostedCheckout — a seller is named', () => {
  it('creates the session on the seller\'s own account with their key, stamping the pending row\'s id on the PaymentIntent metadata', async () => {
    const started = await startHostedCheckout(input());

    expect(started).toEqual({ ok: true, session: SESSION, byoSellerDid: SELLER });
    expect(h.resolveCardRailMock).toHaveBeenCalledWith(SELLER);
    expect(h.createByoSessionMock).toHaveBeenCalledWith(SELLER, {
      items: [{ name: 'Ticket', amount: 2500, quantity: 1 }],
      currency: 'CAD',
      successUrl: 'https://events.test/ok',
      cancelUrl: 'https://events.test/cancel',
      customerEmail: 'buyer@example.com',
      metadata: { service: 'events', eventId: 'ev_1', pay_transaction_id: 'tx_1' },
    });
    expect(h.platformCheckoutMock).not.toHaveBeenCalled();
  });

  it('omits customerEmail when the caller gave none, and defaults the currency to CAD', async () => {
    await startHostedCheckout(input({ customerEmail: undefined, currency: undefined }));

    const sent = h.createByoSessionMock.mock.calls[0][1];
    expect(sent).not.toHaveProperty('customerEmail');
    expect(sent.currency).toBe('CAD');
  });

  it('is a 400 SELLER_NO_CARD_RAIL — with nothing created anywhere — when the seller has no card rail', async () => {
    h.resolveCardRailMock.mockResolvedValue({ kind: 'none' });

    expect(await startHostedCheckout(input())).toEqual({
      ok: false,
      status: 400,
      error: "This seller hasn't set up card payments",
      code: 'SELLER_NO_CARD_RAIL',
    });
    expect(h.createByoSessionMock).not.toHaveBeenCalled();
    expect(h.platformCheckoutMock).not.toHaveBeenCalled();
  });

  it('refuses a subscription — a seller\'s own account is charged in payment mode only', async () => {
    expect(await startHostedCheckout(input({ mode: 'subscription' }))).toMatchObject({
      ok: false,
      status: 400,
      code: 'SUBSCRIPTION_NOT_SUPPORTED',
    });
    expect(h.createByoSessionMock).not.toHaveBeenCalled();
  });

  it.each([
    ['no_key', 'CARD_RAIL_KEY_MISSING'],
    ['key_rejected', 'CARD_RAIL_KEY_REJECTED'],
    ['unavailable', 'CARD_RAIL_UNAVAILABLE'],
    ['request_rejected', 'CARD_RAIL_REQUEST_REJECTED'],
  ])('a Stripe %s failure on the seller\'s account is a logged 502 carrying %s', async (code, expected) => {
    h.createByoSessionMock.mockRejectedValue(new ByoCheckoutError(code as 'no_key', `stripe: ${code}`, 403));

    expect(await startHostedCheckout(input())).toMatchObject({ ok: false, status: 502, code: expected });
    expect(h.errorMock).toHaveBeenCalledWith(expect.objectContaining({ code, sellerDid: SELLER }), expect.any(String));
  });

  it('does not swallow an unexpected (non-Stripe) error', async () => {
    h.createByoSessionMock.mockRejectedValue(new Error('db exploded'));

    await expect(startHostedCheckout(input())).rejects.toThrow('db exploded');
  });
});

describe('startHostedCheckout — no seller is named', () => {
  it('stays a platform-own charge and never asks the card rail', async () => {
    const started = await startHostedCheckout(input({ sellerDid: undefined, mode: 'subscription' }));

    expect(started).toEqual({ ok: true, session: SESSION });
    expect(h.resolveCardRailMock).not.toHaveBeenCalled();
    expect(h.createByoSessionMock).not.toHaveBeenCalled();
    expect(h.platformCheckoutMock).toHaveBeenCalledWith({
      items: [{ name: 'Ticket', amount: 2500, quantity: 1 }],
      currency: 'CAD',
      mode: 'subscription',
      customerEmail: 'buyer@example.com',
      successUrl: 'https://events.test/ok',
      cancelUrl: 'https://events.test/cancel',
      metadata: { service: 'events', eventId: 'ev_1' },
    });
    // The platform request carries no destination account or application fee any more.
    expect(h.platformCheckoutMock.mock.calls[0][0]).not.toHaveProperty('connectedAccountId');
    expect(h.platformCheckoutMock.mock.calls[0][0]).not.toHaveProperty('applicationFeeAmount');
  });
});
