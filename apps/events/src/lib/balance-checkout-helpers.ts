/**
 * Helpers for the balance checkout route.
 * Extracted from app/api/checkout/balance/route.ts to reduce cognitive complexity.
 */

import { getClient } from '@imajin/db';
import { publish } from '@imajin/bus';
import { eventUrl, buildPublicUrlAbsolute } from '@imajin/config';
import type { Logger } from '@imajin/logger';
import type { CartItem } from '@/src/lib/checkout-common';

const MAX_QUANTITY = 20;

// ---------------------------------------------------------------------------
// Cart normalization
// ---------------------------------------------------------------------------

export interface BalanceCartItem {
  ticketTypeId: string;
  quantity: number;
}

function buildRawBalanceItems(body: {
  items?: BalanceCartItem[];
  ticketTypeId?: string;
  quantity?: number;
}): BalanceCartItem[] {
  if (body.items && body.items.length > 0) return body.items;
  if (body.ticketTypeId) {
    return [{ ticketTypeId: body.ticketTypeId, quantity: body.quantity ?? 1 }];
  }
  return [];
}

/**
 * Normalize a balance checkout request body into a coalesced cart, clamping
 * per-type quantities to MAX_QUANTITY (same pattern as the Stripe/e-Transfer routes).
 */
export function normalizeBalanceCart(body: {
  items?: BalanceCartItem[];
  ticketTypeId?: string;
  quantity?: number;
}): { error: string; status: number } | CartItem[] {
  const rawItems = buildRawBalanceItems(body);
  if (rawItems.length === 0) {
    return { error: 'items or ticketTypeId is required', status: 400 };
  }

  const cartMap = new Map<string, number>();
  for (const item of rawItems) {
    if (!item.ticketTypeId) continue;
    const q = Math.max(1, Math.min(MAX_QUANTITY, Math.floor(item.quantity ?? 1)));
    cartMap.set(item.ticketTypeId, (cartMap.get(item.ticketTypeId) ?? 0) + q);
  }

  return Array.from(cartMap.entries()).map(([ticketTypeId, quantity]) => ({
    ticketTypeId,
    quantity: Math.min(MAX_QUANTITY, quantity),
  }));
}

// ---------------------------------------------------------------------------
// Buyer email resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the buyer's email for ticket delivery. Falls back gracefully —
 * never throws.
 */
export async function resolveBalanceBuyerEmail(buyerDid: string, log: Logger): Promise<string | undefined> {
  try {
    const pgClient = getClient();
    const rows = await pgClient<{ contact_email: string | null }[]>`
      SELECT contact_email FROM auth.identities WHERE id = ${buyerDid} LIMIT 1
    `;
    return rows[0]?.contact_email ?? undefined;
  } catch (err) {
    log.warn({ err: String(err) }, 'Failed to resolve buyer email');
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Balance transfer
// ---------------------------------------------------------------------------

export interface BalanceTransferParams {
  payServiceUrl: string;
  cookieHeader: string;
  fromDid: string;
  toDid: string;
  amountCents: number;
  eventId: string;
  cart: CartItem[];
  log: Logger;
}

/**
 * Transfer the buyer's balance to the event creator via the pay service.
 * Returns the transaction id on success, or an `{ error, status }`
 * descriptor the route can respond with directly.
 *
 * `payServiceUrl` (PAY_SERVICE_URL) already includes the `/pay` path prefix
 * — same convention every other cross-service call in this app follows
 * (`requestPayCheckoutSession`'s `/api/checkout`, the order-refund route's
 * `/api/refund`, campaign settle's `/api/charge-pledges`). This call site
 * used to hardcode a duplicated `/pay` segment that pay.yaml never
 * documented (#2002) — fixed to match the documented `/api/balance/transfer`
 * path.
 */
export async function transferBuyerBalance(
  params: BalanceTransferParams,
): Promise<{ transactionId: string } | { error: string; status: number }> {
  const { payServiceUrl, cookieHeader, fromDid, toDid, amountCents, eventId, cart, log } = params;

  const payRes = await fetch(`${payServiceUrl}/api/balance/transfer`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': cookieHeader,
    },
    body: JSON.stringify({
      from_did: fromDid,
      to_did: toDid,
      amount: amountCents / 100, // transfer expects dollars, not cents
      metadata: {
        service: 'events',
        eventId,
        cart: JSON.stringify(cart),
      },
    }),
  });

  if (!payRes.ok) {
    const errBody = await payRes.json().catch(() => ({ error: 'Balance transfer failed' }));
    log.warn({ status: payRes.status, body: errBody }, 'Balance transfer failed');
    return {
      error: errBody.error || 'Insufficient balance or transfer failed',
      status: payRes.status >= 400 && payRes.status < 500 ? payRes.status : 502,
    };
  }

  const transferData = await payRes.json();
  log.info(
    { transactionId: transferData.transactionId, amount: amountCents / 100 },
    'Balance transfer succeeded',
  );
  return { transactionId: transferData.transactionId };
}

// ---------------------------------------------------------------------------
// Post-purchase notifications
// ---------------------------------------------------------------------------

export interface PurchasedTicket {
  id: string;
  ticketTypeId: string;
  pricePaid: number | null;
}

/**
 * Fire the ticket.purchased bus event for each ticket in a balance purchase.
 * Fire-and-forget — publish failures are logged, not thrown.
 */
export function publishBalanceTicketsPurchased(
  tickets: PurchasedTicket[],
  event: { id: string; creatorDid: string },
  buyerDid: string,
  currency: string,
  log: Logger,
): void {
  for (const ticket of tickets) {
    publish('ticket.purchased', {
      issuer: buyerDid,
      subject: event.creatorDid,
      scope: 'events',
      payload: {
        ticketId: ticket.id,
        eventId: event.id,
        amount: ticket.pricePaid ?? 0,
        currency,
        context_id: event.id,
        context_type: 'event',
        to: buyerDid,
        interestDids: [buyerDid],
      },
    }).catch((err) => log.error({ err: String(err) }, 'ticket.purchased publish error'));
  }
}

function resolveBalanceEventImageUrl(imageUrl: string | null | undefined, eventsBase: string): string | undefined {
  if (!imageUrl) return undefined;
  return imageUrl.startsWith('http') ? imageUrl : `${eventsBase}${imageUrl}`;
}

export interface BalanceConfirmationParams {
  buyerEmail: string;
  buyerDid: string;
  event: {
    id: string;
    title: string;
    startsAt: Date | string;
    imageUrl?: string | null;
    isVirtual?: boolean | null;
    venue?: string | null;
  };
  tickets: PurchasedTicket[];
  typesById: Map<string, { name: string }>;
  totalAmount: number;
  log: Logger;
}

/**
 * Send the ticket.confirmed email for each ticket in a balance purchase.
 * Fire-and-forget — publish failures are logged, not thrown.
 */
export function sendBalanceConfirmationEmails(params: BalanceConfirmationParams): void {
  const { buyerEmail, buyerDid, event, tickets, typesById, totalAmount, log } = params;

  try {
    const EVENTS_URL = buildPublicUrlAbsolute('events');
    const eventDate = new Date(event.startsAt);
    const eventImageUrl = resolveBalanceEventImageUrl(event.imageUrl, EVENTS_URL);

    for (const ticket of tickets) {
      const ticketType = typesById.get(ticket.ticketTypeId);
      publish('ticket.confirmed', {
        issuer: buyerDid,
        subject: buyerDid,
        scope: 'events',
        payload: {
          email: buyerEmail,
          eventTitle: event.title,
          ticketType: ticketType?.name ?? 'Ticket',
          ticketId: ticket.id,
          eventDate: eventDate.toLocaleDateString('en-US', {
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
          }),
          eventTime: eventDate.toLocaleTimeString('en-US', {
            hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
          }),
          isVirtual: event.isVirtual ?? false,
          venue: event.venue ?? undefined,
          price: `$${(totalAmount / 100).toFixed(2)} (Balance)`,
          eventImageUrl,
          eventUrl: eventUrl(EVENTS_URL, event.id),
          context_id: event.id,
          context_type: 'event',
        },
      }).catch((err) => log.error({ err: String(err) }, 'ticket.confirmed publish error'));
    }
  } catch (emailError) {
    log.error({ err: String(emailError) }, 'Confirmation publish failed (non-fatal)');
  }
}
