/**
 * Bus reactor registry — maps each event type to its ordered list of reactors.
 *
 * All reactors are fire-and-forget; publish() runs them with Promise.allSettled
 * so one failure never blocks the others.
 */

import * as attestation from './reactors/attestation';
import * as emitReactor from './reactors/emit';
import * as notifyReactor from './reactors/notify';
import * as settleReactor from './reactors/settle';
import type { BusEvent } from './types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyReactor = (payload: any) => Promise<void> | void;

export const registry: Record<BusEvent['type'], AnyReactor[]> = {
  'identity.registered': [
    attestation.onIdentityRegistered,
    emitReactor.onIdentityRegistered,
  ],
  'connection.accepted': [
    attestation.onConnectionAccepted,
    emitReactor.onConnectionAccepted,
    notifyReactor.onConnectionAccepted,
  ],
  'tip.initiated': [
    attestation.onTipInitiated,
  ],
  'ticket.purchased': [
    attestation.onTicketPurchased,
  ],
  'order.completed': [
    notifyReactor.onOrderCompleted,
    settleReactor.onOrderCompleted,
  ],
  'listing.purchased': [
    attestation.onListingPurchased,
    notifyReactor.onListingPurchased,
    settleReactor.onListingPurchased,
  ],
};
