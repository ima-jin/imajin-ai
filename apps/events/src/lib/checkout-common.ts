/**
 * Shared checkout logic for Stripe checkout, E-Transfer checkout, and payment webhook.
 *
 * Extracted to eliminate duplication between:
 * - app/api/checkout/route.ts          (Stripe checkout)
 * - app/api/checkout/etransfer/route.ts (E-Transfer checkout)
 * - app/api/webhook/payment/route.ts    (Stripe payment webhook)
 */

import { NextRequest } from 'next/server';
import { db, ticketTypes, tickets, orders, eventInvites, events } from '@/src/db';
import { eq, and, sql, lt } from 'drizzle-orm';
import { optionalAuth } from '@imajin/auth';
import { getContactEmail, backfillContactEmail } from '@/src/lib/contact-email';
import { randomBytes } from 'node:crypto';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import type { Logger } from '@imajin/logger';
import type { TicketType, Order, Ticket, EventInvite, Event } from '@/src/db/schema';

// Configure ed25519 with sha512
ed.hashes.sha512 = sha512;

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class CheckoutValidationError extends Error {
  constructor(
    message: string,
    public statusCode: number = 400,
    public field?: string,
  ) {
    super(message);
    this.name = 'CheckoutValidationError';
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CartItem {
  ticketTypeId: string;
  quantity: number;
}

export interface ValidateCartOptions {
  checkAvailability?: boolean;
  availabilityStatusCode?: number;
  checkMaxPerOrder?: boolean;
  eventMetadata?: Record<string, any>;
  releaseExpiredHolds?: boolean;
}

export interface ValidatedCart {
  typesById: Map<string, TicketType>;
  totalQuantity: number;
  totalAmount: number;
  currency: string;
}

export interface CreateOrderWithTicketsParams {
  orderId?: string;
  eventId: string;
  buyerDid: string;
  buyerEmail?: string;
  cart: CartItem[];
  typesById: Map<string, TicketType>;
  totalQuantity: number;
  totalAmount: number;
  currency: string;
  paymentMethod: 'stripe' | 'etransfer' | 'free' | 'balance';
  ticketStatus: 'valid' | 'held';
  holdExpiresAt?: Date;
  stripeSessionId?: string;
  paymentId?: string;
  orderMetadata?: Record<string, unknown>;
  ticketMetadata?: Record<string, unknown>;
  eventDid?: string;
  eventPrivateKey?: string | null;
  customerEmail?: string;
  log?: any;
  incrementSold?: boolean;
}

export interface CreateOrderWithTicketsResult {
  order: Order;
  tickets: Ticket[];
}

// ---------------------------------------------------------------------------
// validateCart
// ---------------------------------------------------------------------------

async function fetchTicketTypesById(eventId: string): Promise<Map<string, TicketType>> {
  const fetchedTypes = await db
    .select()
    .from(ticketTypes)
    .where(eq(ticketTypes.eventId, eventId));

  return new Map(fetchedTypes.map((t) => [t.id, t]));
}

function getCartItemTicketType(item: CartItem, typesById: Map<string, TicketType>): TicketType {
  const tt = typesById.get(item.ticketTypeId);
  if (!tt) {
    throw new CheckoutValidationError(
      `Ticket type ${item.ticketTypeId} not found for this event`,
      404,
    );
  }
  return tt;
}

function assertMaxPerOrder(
  item: CartItem,
  tt: TicketType,
  metadataMaxTicketsPerOrder: number | undefined,
): void {
  const maxPerOrder = Math.min(
    tt.maxPerOrder ?? metadataMaxTicketsPerOrder ?? 10,
    20,
  );
  if (item.quantity > maxPerOrder) {
    throw new CheckoutValidationError(`Maximum ${maxPerOrder} tickets per order`, 400);
  }
}

async function releaseExpiredHoldsForItem(item: CartItem): Promise<void> {
  await db
    .update(tickets)
    .set({ status: 'available', heldBy: null, heldUntil: null })
    .where(
      and(
        eq(tickets.ticketTypeId, item.ticketTypeId),
        eq(tickets.status, 'held'),
        lt(tickets.heldUntil, new Date()),
      ),
    );
}

function assertAvailability(item: CartItem, tt: TicketType, availabilityStatusCode: number): void {
  if (tt.quantity === null) return;
  const available = tt.quantity - (tt.sold ?? 0);
  if (available < item.quantity) {
    const suffix = available === 1 ? '' : 's';
    throw new CheckoutValidationError(
      `Only ${available} ${tt.name} ticket${suffix} available`,
      availabilityStatusCode,
    );
  }
}

function assertSingleCurrency(items: CartItem[], typesById: Map<string, TicketType>): void {
  const currencies = new Set(items.map((c) => typesById.get(c.ticketTypeId)!.currency));
  if (currencies.size > 1) {
    throw new CheckoutValidationError('All tickets in a cart must use the same currency', 400);
  }
}

function computeCartTotals(
  items: CartItem[],
  typesById: Map<string, TicketType>,
): { totalQuantity: number; totalAmount: number; currency: string } {
  const totalQuantity = items.reduce((sum, c) => sum + c.quantity, 0);
  const totalAmount = items.reduce(
    (sum, item) => sum + typesById.get(item.ticketTypeId)!.price * item.quantity,
    0,
  );
  const currency = typesById.get(items[0].ticketTypeId)!.currency;
  return { totalQuantity, totalAmount, currency };
}

/**
 * Fetch ticket types for an event, validate cart items, and compute totals.
 *
 * Checks performed (when enabled via options):
 * - Every item references a ticket type that belongs to the event
 * - maxPerOrder limit per type (with event metadata fallback)
 * - Availability: quantity - sold >= requested quantity
 * - All items share the same currency
 */
export async function validateCart(
  eventId: string,
  items: CartItem[],
  options: ValidateCartOptions = {},
): Promise<ValidatedCart> {
  const {
    checkAvailability = false,
    availabilityStatusCode = 409,
    checkMaxPerOrder = false,
    eventMetadata,
    releaseExpiredHolds = false,
  } = options;

  const typesById = await fetchTicketTypesById(eventId);

  for (const item of items) {
    const tt = getCartItemTicketType(item, typesById);

    if (checkMaxPerOrder) {
      assertMaxPerOrder(item, tt, eventMetadata?.maxTicketsPerOrder);
    }
    if (releaseExpiredHolds) {
      await releaseExpiredHoldsForItem(item);
    }
    if (checkAvailability) {
      assertAvailability(item, tt, availabilityStatusCode);
    }
  }

  assertSingleCurrency(items, typesById);
  const { totalQuantity, totalAmount, currency } = computeCartTotals(items, typesById);

  return { typesById, totalQuantity, totalAmount, currency };
}

// ---------------------------------------------------------------------------
// validateInviteAccess
// ---------------------------------------------------------------------------

/**
 * Validate an invite token for an invite-only event.
 *
 * Throws CheckoutValidationError on any check failure.
 * Returns the invite record on success so the caller can increment usedCount.
 */
export async function validateInviteAccess(
  eventId: string,
  token: string | undefined | null,
): Promise<EventInvite> {
  if (!token) {
    throw new CheckoutValidationError(
      'This event requires an invite link',
      403,
    );
  }

  const [invite] = await db
    .select()
    .from(eventInvites)
    .where(and(eq(eventInvites.eventId, eventId), eq(eventInvites.token, token)))
    .limit(1);

  if (!invite) {
    throw new CheckoutValidationError('Invalid invite token', 403);
  }

  if (invite.expiresAt && new Date(invite.expiresAt) < new Date()) {
    throw new CheckoutValidationError(
      'This invite link has expired',
      403,
    );
  }

  if (invite.maxUses !== null && invite.usedCount >= invite.maxUses) {
    throw new CheckoutValidationError(
      'This invite link has reached its maximum uses',
      403,
    );
  }

  return invite;
}

// ---------------------------------------------------------------------------
// loadPublishedEvent
// ---------------------------------------------------------------------------

export type LoadPublishedEventResult =
  | { event: Event }
  | { error: string; status: number };

/**
 * Fetch an event and confirm it accepts checkouts (exists + status is
 * 'published'). Shared by all checkout routes so the not-found/not-published
 * checks stay consistent. `notPublishedMessage` lets callers keep their
 * existing copy for the "not published" case.
 */
export async function loadPublishedEvent(
  eventId: string,
  notPublishedMessage: string = 'Tickets are not available for this event',
): Promise<LoadPublishedEventResult> {
  const [event] = await db.select().from(events).where(eq(events.id, eventId)).limit(1);

  if (!event) {
    return { error: 'Event not found', status: 404 };
  }
  if (event.status !== 'published') {
    return { error: notPublishedMessage, status: 400 };
  }

  return { event };
}

// ---------------------------------------------------------------------------
// syncBuyerToEventChatFireAndForget
// ---------------------------------------------------------------------------

/**
 * Add the buyer to the event chat conversation as a member, fire-and-forget.
 * No-op when chat isn't configured. Shared by the balance and free checkout
 * routes.
 */
export function syncBuyerToEventChatFireAndForget(eventDid: string, buyerDid: string, log: Logger): void {
  const chatUrl = process.env.CHAT_SERVICE_URL || process.env.CHAT_URL;
  if (!chatUrl) return;

  fetch(`${chatUrl}/api/d/${encodeURIComponent(eventDid)}/members`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memberDid: buyerDid, role: 'member' }),
  }).catch((err) => log.warn({ err: String(err) }, 'Event chat member sync failed (non-fatal)'));
}

// ---------------------------------------------------------------------------
// resolveInviteAccessForEvent
// ---------------------------------------------------------------------------

/**
 * Run the invite-only access check for an event when it requires one.
 * No-op (returns undefined) for events that aren't invite-only.
 */
export async function resolveInviteAccessForEvent(
  event: { id: string; accessMode: string },
  token: string | undefined | null,
): Promise<EventInvite | undefined> {
  if (event.accessMode !== 'invite_only') {
    return undefined;
  }
  return validateInviteAccess(event.id, token);
}

// ---------------------------------------------------------------------------
// createOrderWithTickets
// ---------------------------------------------------------------------------

function generateOrderId(): string {
  return `ord_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
}

function buildOrderInsertValues(orderId: string, params: CreateOrderWithTicketsParams) {
  const {
    eventId, buyerDid, buyerEmail, cart, totalQuantity, totalAmount, currency,
    paymentMethod, ticketStatus, stripeSessionId, paymentId, orderMetadata,
  } = params;

  return {
    id: orderId,
    eventId,
    buyerDid,
    ticketTypeId: cart.length === 1 ? cart[0].ticketTypeId : null,
    quantity: totalQuantity,
    amountTotal: totalAmount,
    currency: currency.toUpperCase(),
    paymentMethod,
    stripeSessionId: stripeSessionId || null,
    paymentId: paymentId || null,
    status: ticketStatus === 'held' ? 'pending' : 'completed',
    purchasedAt: ticketStatus === 'valid' ? new Date() : null,
    metadata: orderMetadata || {},
    buyerEmail: buyerEmail || null,
  };
}

/**
 * Sign a ticket with the event's Ed25519 private key, falling back to a
 * base64-encoded signature payload when the event has no private key.
 */
async function signTicketPayload(
  ticketId: string,
  eventId: string,
  eventDid: string | undefined,
  customerEmail: string,
  eventPrivateKey: string | null | undefined,
  log: Logger | undefined,
): Promise<string> {
  const signatureData = `${ticketId}:${eventDid}:${customerEmail}:${Date.now()}`;

  if (eventPrivateKey) {
    const msgBytes = new TextEncoder().encode(signatureData);
    const sigBytes = await ed.signAsync(msgBytes, hexToBytes(eventPrivateKey));
    return bytesToHex(sigBytes);
  }

  log?.warn?.({ eventId }, 'Event has no privateKey — using base64 fallback signature');
  return Buffer.from(signatureData).toString('base64');
}

/**
 * Compute the ticket signature for a newly-created ticket, or null when the
 * ticket isn't valid yet (e.g. held e-Transfer tickets) or has no customer
 * email to bind the signature to.
 */
async function resolveTicketSignature(
  ticketId: string,
  params: CreateOrderWithTicketsParams,
): Promise<string | null> {
  const { ticketStatus, customerEmail, eventId, eventDid, eventPrivateKey, log } = params;
  if (ticketStatus !== 'valid' || !customerEmail) {
    return null;
  }
  return signTicketPayload(ticketId, eventId, eventDid, customerEmail, eventPrivateKey, log);
}

function buildTicketInsertValues(
  ticketId: string,
  item: CartItem,
  tt: TicketType,
  order: Order,
  signature: string | null,
  params: CreateOrderWithTicketsParams,
) {
  const {
    eventId, buyerDid, currency, paymentMethod, ticketStatus, holdExpiresAt,
    stripeSessionId, paymentId, ticketMetadata,
  } = params;

  return {
    id: ticketId,
    eventId,
    ticketTypeId: item.ticketTypeId,
    ownerDid: buyerDid,
    orderId: order.id,
    originalOwnerDid: buyerDid,
    pricePaid: tt.price,
    currency: currency.toUpperCase(),
    paymentId: ticketStatus === 'valid' ? paymentId || stripeSessionId || null : null,
    paymentMethod,
    status: ticketStatus,
    purchasedAt: ticketStatus === 'valid' ? new Date() : null,
    signature,
    heldBy: ticketStatus === 'held' ? buyerDid : null,
    heldUntil: holdExpiresAt || null,
    holdExpiresAt: holdExpiresAt || null,
    registrationStatus: tt.requiresRegistration ? 'pending' : 'not_required',
    metadata: ticketMetadata || {},
  };
}

async function insertTicketsForCart(
  order: Order,
  params: CreateOrderWithTicketsParams,
): Promise<Ticket[]> {
  const { cart, typesById } = params;
  const createdTickets: Ticket[] = [];
  let idx = 0;

  for (const item of cart) {
    const tt = typesById.get(item.ticketTypeId)!;

    for (let i = 0; i < item.quantity; i++) {
      const ticketId = `tkt_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}_${idx++}`;
      const signature = await resolveTicketSignature(ticketId, params);

      const [ticket] = await db
        .insert(tickets)
        .values(buildTicketInsertValues(ticketId, item, tt, order, signature, params))
        .returning();

      createdTickets.push(ticket);
    }
  }

  return createdTickets;
}

async function incrementSoldCounts(cart: CartItem[]): Promise<void> {
  for (const item of cart) {
    await db
      .update(ticketTypes)
      .set({ sold: sql`${ticketTypes.sold} + ${item.quantity}` })
      .where(eq(ticketTypes.id, item.ticketTypeId));
  }
}

/**
 * Create an order and its associated tickets.
 *
 * Handles both held (e-Transfer pending) and valid (paid) tickets.
 * Ed25519 signing is performed when eventPrivateKey is provided and
 * ticketStatus is 'valid'.
 *
 * Optionally increments the sold count on ticket types.
 */
export async function createOrderWithTickets(
  params: CreateOrderWithTicketsParams,
): Promise<CreateOrderWithTicketsResult> {
  const orderId = params.orderId ?? generateOrderId();

  const [order] = await db
    .insert(orders)
    .values(buildOrderInsertValues(orderId, params))
    .returning();

  const createdTickets = await insertTicketsForCart(order, params);

  if (params.incrementSold) {
    await incrementSoldCounts(params.cart);
  }

  return { order, tickets: createdTickets };
}

// ---------------------------------------------------------------------------
// resolveCheckoutIdentity
// ---------------------------------------------------------------------------

/**
 * Resolve the buyer's identity for checkout. Canonical for ALL checkout paths
 * (Stripe, e-Transfer, free RSVP). Do not re-implement identity resolution in
 * a checkout route — extend this with an option instead.
 *
 * 1. Attempt session auth (optionalAuth).
 * 2. If authenticated: backfill contact email if provided, resolve the stored
 *    contact email, return DID + resolved email.
 * 3. If not authenticated:
 *    - default: return just the email (caller defers DID creation — Stripe
 *      hands the email to the pay service; e-Transfer sends a magic-link).
 *    - `createSoftDid: true`: eagerly create/resolve a soft DID from the email
 *      (free RSVP needs a ticket owner immediately — there is no later step to
 *      defer to). Requires `email`.
 *
 * `opts.name` is used only when minting a soft DID.
 */
export async function resolveCheckoutIdentity(
  request: NextRequest,
  body: { email?: string; name?: string },
  log: any,
  opts?: { createSoftDid?: boolean },
): Promise<{ did?: string; email?: string }> {
  const session = await optionalAuth(request);

  if (session) {
    const did = session.id;
    let email = body.email;

    if (email) {
      await backfillContactEmail(did, email, log);
      // Soft-DID/free flows also rely on profile.profiles.contact_email for
      // ticket delivery; keep both stores aligned for authenticated buyers.
      await backfillProfileContactEmail(did, email, log);
    }

    const contactEmail = await getContactEmail(did, log);
    if (!email && contactEmail) {
      email = contactEmail;
    }

    return { did, email };
  }

  if (opts?.createSoftDid) {
    if (!body.email) {
      throw new Error('email is required to create a soft DID for checkout');
    }
    const did = await createSoftDidFromEmail(body.email, body.name);
    await backfillProfileContactEmail(did, body.email, log);
    return { did, email: body.email };
  }

  return { email: body.email };
}

/**
 * Create or retrieve a soft DID from an email via the auth service.
 * Canonical for checkout soft-DID minting.
 */
async function createSoftDidFromEmail(email: string, name?: string): Promise<string> {
  const authUrl = process.env.AUTH_SERVICE_URL || process.env.AUTH_URL || process.env.NEXT_PUBLIC_AUTH_URL;
  const response = await fetch(`${authUrl}/api/session/soft`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email.toLowerCase().trim(), name: name?.trim() }),
  });
  if (!response.ok) {
    throw new Error(`Soft DID creation failed: ${response.status}`);
  }
  const data = await response.json();
  return data.did;
}

/**
 * Backfill profile.profiles.contact_email (distinct from the auth.identities
 * store handled by backfillContactEmail — both are load-bearing for notify
 * resolution order: profile → auth → www).
 */
async function backfillProfileContactEmail(did: string, email: string, log: any): Promise<void> {
  try {
    const normalizedEmail = email.toLowerCase().trim();
    await db.execute(
      sql`UPDATE profile.profiles SET contact_email = ${normalizedEmail} WHERE did = ${did} AND (contact_email IS NULL OR contact_email = '')`
    );
  } catch (error) {
    log.error({ err: String(error) }, 'backfillProfileContactEmail error');
  }
}
