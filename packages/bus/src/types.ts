/**
 * BusEvent discriminated union — all events that flow through the @imajin/bus pipeline.
 *
 * Each event type carries exactly the payload its reactors need.
 * Routes construct the payload and call bus.publish(); reactors handle side-effects.
 */

export interface IdentityRegisteredPayload {
  did: string;
  scope: string;
  subtype: string | null;
  tier: string;
  /** Platform/node DID used as issuer for identity.verified.preliminary attestation */
  platformDid: string;
}

export interface ConnectionAcceptedPayload {
  /** Newly registered user's DID */
  did: string;
  /** Inviter's DID */
  fromDid: string;
  /** Handle or truncated DID of the newly registered user (for notifications) */
  newUserLabel: string;
  podId: string;
  inviteCode: string;
}

export interface TipInitiatedPayload {
  fromDid: string;
  fromHumanDid: string;
  /** Page owner DID */
  toDid: string;
  tipId: string;
  amount: number;
  currency: string;
}

export interface TicketPurchasedPayload {
  ownerDid: string;
  /** Event creator DID */
  creatorDid: string;
  eventId: string;
  ticketId: string;
  /** Per-ticket amount in cents */
  amount: number;
  currency: string;
}

export interface FairFee {
  role: string;
  name: string;
  rateBps: number;
  fixedCents: number;
}

export interface FairEntry {
  did: string;
  role: string;
  share: number;
}

export interface FairManifest {
  version?: string;
  fees?: FairFee[];
  chain?: FairEntry[];
  [key: string]: unknown;
}

export interface OrderCompletedPayload {
  ownerDid: string;
  eventId: string;
  eventTitle: string;
  ticketTypeName: string;
  orderId: string;
  /** Total amount in cents */
  amount: number;
  currency: string;
  customerEmail: string;
  fairManifest: FairManifest | null;
  metadata: {
    ticketIds: string[];
    ticketTypeId: string;
    stripeSessionId: string;
  };
}

export interface ListingPurchasedPayload {
  buyerDid: string;
  sellerDid: string;
  listingId: string;
  /** Amount in cents */
  amount: number;
  currency: string;
  fairManifest: FairManifest | null;
}

export type BusEvent =
  | { type: 'identity.registered'; payload: IdentityRegisteredPayload }
  | { type: 'connection.accepted'; payload: ConnectionAcceptedPayload }
  | { type: 'tip.initiated'; payload: TipInitiatedPayload }
  | { type: 'ticket.purchased'; payload: TicketPurchasedPayload }
  | { type: 'order.completed'; payload: OrderCompletedPayload }
  | { type: 'listing.purchased'; payload: ListingPurchasedPayload };

export type BusEventType = BusEvent['type'];
export type BusPayload<T extends BusEventType> = Extract<BusEvent, { type: T }>['payload'];
