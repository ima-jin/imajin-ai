/**
 * Helpers for the e-Transfer checkout route.
 * Extracted from app/api/checkout/etransfer/route.ts to reduce cognitive complexity.
 */

import { NextResponse } from 'next/server';
import { db, tickets, orders } from '@/src/db';
import { eq, and } from 'drizzle-orm';
import { getClient } from '@imajin/db';
import { publish } from '@imajin/bus';
import { eventUrl, eventMyTicketsUrl, buildPublicUrlAbsolute } from '@imajin/config';
import type { CartItem } from '@/src/lib/checkout-common';

const AUTH_URL = process.env.AUTH_SERVICE_URL || process.env.AUTH_URL || 'http://localhost:3001';
const MAX_QUANTITY = 20;

export interface ETransferCartItem {
  ticketTypeId: string;
  quantity: number;
}

export interface NormalizedCart {
  cart: CartItem[];
  cartMap: Map<string, number>;
  totalQuantity: number;
}

/**
 * Normalize legacy {ticketTypeId, quantity} OR multi-type {items:[...]} into a
 * coalesced cart, clamping per-type quantities to MAX_QUANTITY.
 *
 * Returns an error response when the resulting cart is empty.
 */
export function normalizeAndCoalesceCart(body: {
  items?: ETransferCartItem[];
  ticketTypeId?: string;
  quantity?: number;
}): { error: string; status: number } | NormalizedCart {
  const rawItems = buildRawItems(body);
  if (rawItems.length === 0) {
    return { error: 'items or ticketTypeId is required', status: 400 };
  }
  return coalesceCartItems(rawItems);
}

function buildRawItems(body: {
  items?: ETransferCartItem[];
  ticketTypeId?: string;
  quantity?: number;
}): ETransferCartItem[] {
  if (body.items && body.items.length > 0) return body.items;
  if (body.ticketTypeId) {
    return [{ ticketTypeId: body.ticketTypeId, quantity: body.quantity ?? 1 }];
  }
  return [];
}

function coalesceCartItems(rawItems: ETransferCartItem[]): NormalizedCart {
  const cartMap = new Map<string, number>();
  for (const item of rawItems) {
    if (!item.ticketTypeId) continue;
    const q = Math.max(1, Math.min(MAX_QUANTITY, Math.floor(item.quantity ?? 1)));
    cartMap.set(item.ticketTypeId, (cartMap.get(item.ticketTypeId) ?? 0) + q);
  }
  const cart: CartItem[] = Array.from(cartMap.entries()).map(([ticketTypeId, quantity]) => ({
    ticketTypeId,
    quantity: Math.min(MAX_QUANTITY, quantity),
  }));
  const totalQuantity = cart.reduce((sum, c) => sum + c.quantity, 0);
  return { cart, cartMap, totalQuantity };
}

// ---------------------------------------------------------------------------
// Anonymous magic-link flow
// ---------------------------------------------------------------------------

export interface MagicLinkParams {
  email: string;
  name?: string;
  /** Events app event ID — used to build the post-verification redirect URL. */
  eventId: string;
  /** Invite token (optional) appended to the redirect URL. */
  invite?: string;
  totalQuantity: number;
  log: any;
}

/**
 * Send a magic-link verification email to an anonymous buyer.
 * Returns a NextResponse to return immediately from the route handler.
 */
export async function handleAnonymousMagicLink(params: MagicLinkParams): Promise<NextResponse> {
  const { email, name, eventId, invite, totalQuantity, log } = params;
  const eventsBase = buildPublicUrlAbsolute('events');
  const redirectUrl = `${eventUrl(eventsBase, eventId)}${invite ? `?invite=${encodeURIComponent(invite)}` : ''}`;
  let pollHandle: string | undefined;

  try {
    const onboardRes = await fetch(`${AUTH_URL}/api/onboard`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        name,
        redirectUrl,
        context: 'reserve your tickets',
        wantPolling: true,
      }),
    });

    if (!onboardRes.ok) {
      return buildMagicLinkErrorResponse(onboardRes, log);
    }

    const onboardData = await onboardRes.json();
    pollHandle = onboardData.pollHandle;
  } catch (err) {
    log.error({ err: String(err) }, 'Magic-link send error');
    return NextResponse.json(
      { error: 'Could not send verification email. Please try again.' },
      { status: 502 },
    );
  }

  return NextResponse.json({
    verificationSent: true,
    email,
    ...(pollHandle ? { pollHandle } : {}),
    message: `We sent a verification link to ${email}. Click it to confirm your email and reserve your ticket${totalQuantity > 1 ? 's' : ''}.`,
  });
}

async function buildMagicLinkErrorResponse(res: Response, log: any): Promise<NextResponse> {
  const errBody = await res.text().catch(() => '');
  log.error({ status: res.status, body: errBody }, 'Magic-link send failed');
  const propagateStatus = res.status === 429 || res.status === 410 ? res.status : 502;
  let message = 'Could not send verification email. Please try again.';
  try {
    const parsed = JSON.parse(errBody);
    if (parsed.error) message = parsed.error;
  } catch { /* ignore parse failure, use generic */ }
  return NextResponse.json({ error: message }, { status: propagateStatus });
}

// ---------------------------------------------------------------------------
// Duplicate-order detection
// ---------------------------------------------------------------------------

export interface ExistingOrderInstructions {
  orderId: string;
  ticketIds: string[];
  instructions: {
    email: string;
    amount: number;
    currency: string;
    memo: string;
    deadline: Date | undefined;
    quantity: number;
    message: string;
  };
}

/**
 * Look for an existing pending e-Transfer order from the same buyer covering
 * exactly the same cart shape. Returns the instructions response payload when
 * a matching order is found, or null when none matches.
 */
export async function findExistingEtransferOrder(
  eventId: string,
  ownerDid: string,
  cartMap: Map<string, number>,
  etransferEmail: string,
): Promise<ExistingOrderInstructions | null> {
  const existingOrders = await db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.eventId, eventId),
        eq(orders.buyerDid, ownerDid),
        eq(orders.status, 'pending'),
        eq(orders.paymentMethod, 'etransfer'),
      ),
    );

  for (const existing of existingOrders) {
    const result = await checkOrderMatchesCart(existing, cartMap, etransferEmail);
    if (result) return result;
  }
  return null;
}

async function checkOrderMatchesCart(
  existing: typeof orders.$inferSelect,
  cartMap: Map<string, number>,
  etransferEmail: string,
): Promise<ExistingOrderInstructions | null> {
  const heldTickets = await db.select().from(tickets).where(eq(tickets.orderId, existing.id));

  const existingCart = new Map<string, number>();
  for (const t of heldTickets) {
    existingCart.set(t.ticketTypeId, (existingCart.get(t.ticketTypeId) ?? 0) + 1);
  }

  const shapeMatches =
    existingCart.size === cartMap.size &&
    Array.from(cartMap.entries()).every(([k, v]) => existingCart.get(k) === v);

  if (!shapeMatches) return null;

  const earliestDeadline = heldTickets
    .map((t) => t.holdExpiresAt)
    .filter((d): d is Date => !!d)
    .sort((a, b) => a.getTime() - b.getTime())[0];

  return {
    orderId: existing.id,
    ticketIds: heldTickets.map((t) => t.id),
    instructions: {
      email: etransferEmail,
      amount: existing.amountTotal / 100,
      currency: existing.currency,
      memo: `ORD-${existing.id}`,
      deadline: earliestDeadline,
      quantity: existing.quantity,
      message: `Your ${existing.quantity} ticket${existing.quantity > 1 ? 's are' : ' is'} reserved. Send one e-Transfer for the full amount; once we confirm it, your tickets will be activated.`,
    },
  };
}

// ---------------------------------------------------------------------------
// Buyer email resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the buyer's email from the DB when not already known.
 * Falls back gracefully — never throws.
 */
export async function resolveBuyerEmailFromDb(
  ownerDid: string,
  ownerEmail: string | undefined,
  log: any,
): Promise<string | undefined> {
  if (ownerEmail) return ownerEmail;
  try {
    const sql = getClient();
    const rows = await sql<{ contact_email: string | null }[]>`
      SELECT contact_email FROM auth.identities WHERE id = ${ownerDid} LIMIT 1
    `;
    return rows[0]?.contact_email ?? undefined;
  } catch (err) {
    log.warn({ err: String(err) }, 'Failed to resolve buyer email for reservation');
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Reservation email publishing
// ---------------------------------------------------------------------------

export interface ReservationEmailParams {
  buyerEmail: string;
  ownerDid: string;
  event: {
    id: string;
    title: string;
    startsAt: Date | string;
    imageUrl?: string | null;
  };
  cart: CartItem[];
  typesById: Map<string, { name: string }>;
  totalQuantity: number;
  amount: number;
  cartCurrency: string;
  etransferEmail: string;
  memo: string;
  holdUntil: Date;
  log: any;
}

/**
 * Publish the ticket.reserved bus event to send a reservation confirmation
 * email to the buyer. Fire-and-forget — errors are logged, not thrown.
 */
export function publishReservationEmail(params: ReservationEmailParams): void {
  const {
    buyerEmail, ownerDid, event, cart, typesById, totalQuantity,
    amount, cartCurrency, etransferEmail, memo, holdUntil, log,
  } = params;

  if (!buyerEmail) {
    log.warn({ ownerDid, eventId: event.id }, 'No buyer email available for reservation; skipping confirmation send');
    return;
  }

  const EVENTS_URL = buildPublicUrlAbsolute('events');
  const eventDate = new Date(event.startsAt);
  const eventImageUrl = resolveEventImageUrl(event.imageUrl, EVENTS_URL);

  const summary = cart.map((item) => ({
    typeName: typesById.get(item.ticketTypeId)?.name ?? 'Ticket',
    quantity: item.quantity,
  }));

  const formattedAmount = new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency: cartCurrency,
  }).format(amount);

  const formattedDeadline = holdUntil.toLocaleString('en-CA', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });

  publish('ticket.reserved', {
    issuer: ownerDid,
    subject: ownerDid,
    scope: 'events',
    payload: {
      email: buyerEmail,
      eventTitle: event.title,
      eventDate: eventDate.toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      }),
      eventTime: eventDate.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short',
      }),
      ticketSummary: summary,
      totalQuantity,
      amount: formattedAmount,
      payToEmail: etransferEmail,
      memo,
      deadline: formattedDeadline,
      buyerEmail,
      myTicketsUrl: eventMyTicketsUrl(EVENTS_URL, event.id),
      eventImageUrl,
      context_id: event.id,
      context_type: 'event',
    },
  }).catch((err) => log.error({ err: String(err) }, 'Failed to publish ticket reserved event'));
}

function resolveEventImageUrl(imageUrl: string | null | undefined, eventsBase: string): string | undefined {
  if (!imageUrl) return undefined;
  return imageUrl.startsWith('http') ? imageUrl : `${eventsBase}${imageUrl}`;
}
