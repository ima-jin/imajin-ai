/**
 * Shared checkout logic for Stripe checkout, E-Transfer checkout, and payment webhook.
 *
 * Extracted to eliminate duplication between:
 * - app/api/checkout/route.ts          (Stripe checkout)
 * - app/api/checkout/etransfer/route.ts (E-Transfer checkout)
 * - app/api/webhook/payment/route.ts    (Stripe payment webhook)
 */

import { NextRequest } from 'next/server';
import { db, ticketTypes, tickets, orders, eventInvites } from '@/src/db';
import { eq, and, sql, lt } from 'drizzle-orm';
import { optionalAuth } from '@imajin/auth';
import { getContactEmail, backfillContactEmail } from '@/src/lib/contact-email';
import { randomBytes } from 'node:crypto';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import type { TicketType, Order, Ticket, EventInvite } from '@/src/db/schema';

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

  // Fetch all ticket types for this event
  const fetchedTypes = await db
    .select()
    .from(ticketTypes)
    .where(eq(ticketTypes.eventId, eventId));

  const typesById = new Map(fetchedTypes.map((t) => [t.id, t]));

  for (const item of items) {
    const tt = typesById.get(item.ticketTypeId);

    if (!tt) {
      throw new CheckoutValidationError(
        `Ticket type ${item.ticketTypeId} not found for this event`,
        404,
      );
    }

    if (checkMaxPerOrder) {
      const maxPerOrder = Math.min(
        tt.maxPerOrder ?? eventMetadata?.maxTicketsPerOrder ?? 10,
        20,
      );
      if (item.quantity > maxPerOrder) {
        throw new CheckoutValidationError(
          `Maximum ${maxPerOrder} tickets per order`,
          400,
        );
      }
    }

    if (releaseExpiredHolds) {
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

    if (checkAvailability) {
      if (tt.quantity !== null) {
        const available = tt.quantity - (tt.sold ?? 0);
        if (available < item.quantity) {
          const suffix = available === 1  ? '' : 's';
          throw new CheckoutValidationError(
            `Only ${available} ${tt.name} ticket${suffix} available`,
            availabilityStatusCode,
          );
        }
      }
    }
  }

  // All ticket types in a cart must share a currency
  const currencies = new Set(items.map((c) => typesById.get(c.ticketTypeId)!.currency));
  if (currencies.size > 1) {
    throw new CheckoutValidationError(
      'All tickets in a cart must use the same currency',
      400,
    );
  }

  const totalQuantity = items.reduce((sum, c) => sum + c.quantity, 0);
  const totalAmount = items.reduce(
    (sum, item) => sum + typesById.get(item.ticketTypeId)!.price * item.quantity,
    0,
  );
  const currency = typesById.get(items[0].ticketTypeId)!.currency;

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
// createOrderWithTickets
// ---------------------------------------------------------------------------

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
  const {
    orderId: providedOrderId,
    eventId,
    buyerDid,
    buyerEmail,
    cart,
    typesById,
    totalQuantity,
    totalAmount,
    currency,
    paymentMethod,
    ticketStatus,
    holdExpiresAt,
    stripeSessionId,
    paymentId,
    orderMetadata,
    ticketMetadata,
    eventDid,
    eventPrivateKey,
    customerEmail,
    log,
    incrementSold = false,
  } = params;

  const orderId =
    providedOrderId ??
    `ord_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;

  // Insert order
  const [order] = await db
    .insert(orders)
    .values({
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
    })
    .returning();

  // Create tickets
  const createdTickets: Ticket[] = [];
  let idx = 0;

  for (const item of cart) {
    const tt = typesById.get(item.ticketTypeId)!;

    for (let i = 0; i < item.quantity; i++) {
      const ticketId = `tkt_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}_${idx++}`;

      // Sign ticket with event's Ed25519 private key when valid
      let signature: string | null = null;
      if (ticketStatus === 'valid' && customerEmail) {
        const signatureData = `${ticketId}:${eventDid}:${customerEmail}:${Date.now()}`;
        const msgBytes = new TextEncoder().encode(signatureData);

        if (eventPrivateKey) {
          const sigBytes = await ed.signAsync(msgBytes, hexToBytes(eventPrivateKey));
          signature = bytesToHex(sigBytes);
        } else {
          log?.warn?.(
            { eventId },
            'Event has no privateKey — using base64 fallback signature',
          );
          signature = Buffer.from(signatureData).toString('base64');
        }
      }

      const [ticket] = await db
        .insert(tickets)
        .values({
          id: ticketId,
          eventId,
          ticketTypeId: item.ticketTypeId,
          ownerDid: buyerDid,
          orderId: order.id,
          originalOwnerDid: buyerDid,
          pricePaid: tt.price,
          currency: currency.toUpperCase(),
          paymentId:
            ticketStatus === 'valid' ? paymentId || stripeSessionId || null : null,
          paymentMethod,
          status: ticketStatus,
          purchasedAt: ticketStatus === 'valid' ? new Date() : null,
          signature,
          heldBy: ticketStatus === 'held' ? buyerDid : null,
          heldUntil: holdExpiresAt || null,
          holdExpiresAt: holdExpiresAt || null,
          registrationStatus: tt.requiresRegistration ? 'pending' : 'not_required',
          metadata: ticketMetadata || {},
        })
        .returning();

      createdTickets.push(ticket);
    }
  }

  // Increment sold count
  if (incrementSold) {
    for (const item of cart) {
      await db
        .update(ticketTypes)
        .set({ sold: sql`${ticketTypes.sold} + ${item.quantity}` })
        .where(eq(ticketTypes.id, item.ticketTypeId));
    }
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
