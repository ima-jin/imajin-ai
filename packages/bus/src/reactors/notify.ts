/**
 * Notify reactor — wraps notify.send and notify.interest from @imajin/notify.
 *
 * All calls are fire-and-forget; errors are logged but never thrown.
 */

import { notify } from '@imajin/notify';
import { createLogger } from '@imajin/logger';
import type {
  ConnectionAcceptedPayload,
  OrderCompletedPayload,
  ListingPurchasedPayload,
} from '../types';

const log = createLogger('bus');

export async function onConnectionAccepted(payload: ConnectionAcceptedPayload): Promise<void> {
  const { fromDid, newUserLabel } = payload;

  await notify
    .send({
      to: fromDid,
      scope: 'connection:invite-accepted',
      data: { name: newUserLabel },
    })
    .catch((err) => log.error({ err: String(err) }, '[bus/notify] connection:invite-accepted error'));
}

export async function onOrderCompleted(payload: OrderCompletedPayload): Promise<void> {
  const { ownerDid, customerEmail, eventTitle, ticketTypeName, amount, currency } = payload;

  await notify
    .send({
      to: ownerDid,
      scope: 'event:ticket',
      data: {
        email: customerEmail,
        eventTitle,
        ticketType: ticketTypeName,
        amount,
        currency: currency.toUpperCase(),
      },
    })
    .catch((err) => log.error({ err: String(err) }, '[bus/notify] event:ticket error'));

  await notify
    .interest({ did: ownerDid, attestationType: 'ticket.purchased' })
    .catch((err) => log.error({ err: String(err) }, '[bus/notify] interest(ticket.purchased) error'));
}

export async function onListingPurchased(payload: ListingPurchasedPayload): Promise<void> {
  const { buyerDid, sellerDid } = payload;

  if (buyerDid) {
    await notify
      .interest({ did: buyerDid, attestationType: 'listing.purchased' })
      .catch((err) => log.error({ err: String(err) }, '[bus/notify] interest(listing.purchased buyer) error'));
  }

  if (sellerDid) {
    await notify
      .interest({ did: sellerDid, attestationType: 'listing.purchased' })
      .catch((err) => log.error({ err: String(err) }, '[bus/notify] interest(listing.purchased seller) error'));
  }
}
