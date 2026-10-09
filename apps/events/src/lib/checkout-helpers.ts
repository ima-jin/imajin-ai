/**
 * Helpers for the Stripe checkout route.
 * Extracted from app/api/checkout/route.ts to reduce cognitive complexity.
 */

import { NextResponse } from 'next/server';
import type { Logger } from '@imajin/logger';
import type { CartItem } from '@/src/lib/checkout-common';
import type { AppCheckoutAuth } from './pay-settle';

const MAX_QUANTITY = 20;

// ---------------------------------------------------------------------------
// Cart normalization
// ---------------------------------------------------------------------------

export interface CheckoutCartItem {
  ticketTypeId: string;
  quantity: number;
}

/**
 * Normalize a checkout request body into a typed cart array.
 * Accepts either `items[]` (multi-type) or legacy `ticketTypeId` + `quantity`.
 * Clamps each quantity to 1–MAX_QUANTITY.
 *
 * Returns `{ error, status }` when the cart is empty, otherwise the `CartItem[]`.
 */
export function normalizeCheckoutCart(body: {
  items?: CheckoutCartItem[];
  ticketTypeId?: string;
  quantity?: number;
}): { error: string; status: number } | CartItem[] {
  let rawItems: CheckoutCartItem[];
  if (body.items && body.items.length > 0) {
    rawItems = body.items;
  } else if (body.ticketTypeId) {
    rawItems = [{ ticketTypeId: body.ticketTypeId, quantity: body.quantity ?? 1 }];
  } else {
    rawItems = [];
  }

  if (rawItems.length === 0) {
    return { error: 'items or ticketTypeId is required', status: 400 };
  }

  return rawItems.map((item) => ({
    ticketTypeId: item.ticketTypeId,
    quantity: Math.max(1, Math.min(MAX_QUANTITY, Math.floor(item.quantity ?? 1))),
  }));
}

// ---------------------------------------------------------------------------
// Per-item availability validation
// ---------------------------------------------------------------------------

/**
 * Validate per-item limits and availability for a Stripe checkout cart.
 * Returns a 400/409 NextResponse on the first violation, null when all items pass.
 */
export function validateCheckoutCartLimits(
  cart: CartItem[],
  typesById: Map<string, { name: string; maxPerOrder?: number | null; quantity: number | null; sold?: number | null }>,
  eventMeta: Record<string, any>,
): NextResponse | null {
  for (const item of cart) {
    const tt = typesById.get(item.ticketTypeId)!;
    const maxPerOrder = Math.min(tt.maxPerOrder ?? eventMeta.maxTicketsPerOrder ?? 10, MAX_QUANTITY);
    if (item.quantity > maxPerOrder) {
      return NextResponse.json(
        { error: `Maximum ${maxPerOrder} ${tt.name} tickets per order` },
        { status: 400 },
      );
    }
    const availabilityError = checkAvailability(item, tt);
    if (availabilityError) return availabilityError;
  }
  return null;
}

function checkAvailability(
  item: CartItem,
  tt: { name: string; quantity: number | null; sold?: number | null },
): NextResponse | null {
  if (tt.quantity === null) return null;
  const available = tt.quantity - (tt.sold ?? 0);
  if (available < item.quantity) {
    return NextResponse.json(
      { error: `Only ${available} ${tt.name} ticket${available === 1 ? '' : 's'} available` },
      { status: 409 },
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Stripe line items
// ---------------------------------------------------------------------------

export interface StripeCheckoutItem {
  name: string;
  description?: string;
  amount: number;
  quantity: number;
}

/**
 * Build the pay-service line items for a Stripe checkout cart.
 */
export function buildStripeCheckoutItems(
  cart: CartItem[],
  typesById: Map<string, { name: string; description?: string | null; price: number }>,
  eventTitle: string,
): StripeCheckoutItem[] {
  return cart.map((c) => {
    const tt = typesById.get(c.ticketTypeId)!;
    return {
      name: `${eventTitle} — ${tt.name}`,
      description: tt.description || undefined,
      amount: tt.price,
      quantity: c.quantity,
    };
  });
}

// ---------------------------------------------------------------------------
// Pay service checkout session
// ---------------------------------------------------------------------------

/** The pay service's stable `code` when the seller has no card rail (#2757). */
export const SELLER_NO_CARD_RAIL = 'SELLER_NO_CARD_RAIL';

/** What the buyer is told when the organizer has not set up card payments. */
export const NO_CARD_RAIL_MESSAGE = "Card payment isn't set up for this event yet. Try e-Transfer if it's offered, or contact the organizer.";

export interface RequestPayCheckoutSessionParams {
  payServiceUrl: string;
  items: StripeCheckoutItem[];
  currency: string;
  customerEmail?: string;
  successUrl: string;
  cancelUrl: string;
  fairManifest: unknown;
  sellerDid: string;
  metadata: Record<string, unknown>;
  /**
   * Events' own app-service token + the payee manifest it declares (#2739). When present the
   * checkout is authenticated as the events app, so the pay service binds the payment to it and
   * events can later settle it via `/api/settle`. Absent for an event with no `.fair` chain.
   */
  appAuth?: AppCheckoutAuth | null;
  log: Logger;
}

export interface PayCheckoutSession {
  id: string;
  url: string;
}

/**
 * Request a checkout session from the pay service. Returns the session on
 * success, or an `{ error, status }` descriptor the route can respond with
 * directly.
 */
export async function requestPayCheckoutSession(
  params: RequestPayCheckoutSessionParams,
): Promise<{ checkout: PayCheckoutSession } | { error: string; status: number; code?: string }> {
  const { payServiceUrl, log, appAuth, ...body } = params;

  const payResponse = await fetch(`${payServiceUrl}/api/checkout`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(appAuth && { Authorization: `Bearer ${appAuth.bearer}` }),
    },
    body: JSON.stringify(appAuth ? { ...body, payeeManifest: appAuth.payeeManifest } : body),
  });

  if (!payResponse.ok) {
    const error = await payResponse.json().catch(() => ({}));
    // #2757: the organizer has no card rail (no connected Stripe key). Not a server fault — say so plainly.
    if (error.code === SELLER_NO_CARD_RAIL) {
      return { error: NO_CARD_RAIL_MESSAGE, status: 400, code: SELLER_NO_CARD_RAIL };
    }
    log.error({ err: String(error) }, 'Pay service error');
    return { error: error.error || 'Payment service error', status: 500 };
  }

  const checkout = await payResponse.json();
  return { checkout };
}
