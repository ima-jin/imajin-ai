/**
 * Attestation reactor — wraps emitAttestation from @imajin/auth.
 *
 * All calls are fire-and-forget; errors are logged but never thrown.
 */

import { emitAttestation } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import type {
  IdentityRegisteredPayload,
  ConnectionAcceptedPayload,
  TipInitiatedPayload,
  TicketPurchasedPayload,
  ListingPurchasedPayload,
} from '../types';

const log = createLogger('bus');

export async function onIdentityRegistered(payload: IdentityRegisteredPayload): Promise<void> {
  const { did, scope, subtype, tier, platformDid } = payload;

  await emitAttestation({
    issuer_did: did,
    subject_did: did,
    type: 'identity.created',
    context_id: did,
    context_type: 'identity',
    payload: { tier, scope, subtype },
  }).catch((err) => log.error({ err: String(err) }, '[bus/attestation] identity.created error'));

  if (platformDid) {
    await emitAttestation({
      issuer_did: platformDid,
      subject_did: did,
      type: 'identity.verified.preliminary',
      context_id: did,
      context_type: 'identity',
      payload: { tier, scope, subtype },
    }).catch((err) => log.error({ err: String(err) }, '[bus/attestation] identity.verified.preliminary error'));
  }
}

export async function onConnectionAccepted(payload: ConnectionAcceptedPayload): Promise<void> {
  const { did, fromDid, podId, inviteCode } = payload;

  await emitAttestation({
    issuer_did: did,
    subject_did: fromDid,
    type: 'connection.accepted',
    context_id: podId,
    context_type: 'connection',
    payload: { invite_code: inviteCode },
  }).catch((err) => log.error({ err: String(err) }, '[bus/attestation] connection.accepted error'));

  await emitAttestation({
    issuer_did: fromDid,
    subject_did: did,
    type: 'vouch',
    context_id: podId,
    context_type: 'connection',
    payload: { invite_code: inviteCode },
  }).catch((err) => log.error({ err: String(err) }, '[bus/attestation] vouch error'));
}

export async function onTipInitiated(payload: TipInitiatedPayload): Promise<void> {
  const { fromHumanDid, toDid, tipId, amount, currency } = payload;

  await emitAttestation({
    issuer_did: fromHumanDid,
    subject_did: toDid,
    type: 'tip.granted',
    context_id: tipId,
    context_type: 'coffee',
    payload: { amount, currency },
  }).catch((err) => log.error({ err: String(err) }, '[bus/attestation] tip.granted error'));
}

export async function onTicketPurchased(payload: TicketPurchasedPayload): Promise<void> {
  const { ownerDid, creatorDid, eventId, ticketId, amount, currency } = payload;

  await emitAttestation({
    issuer_did: ownerDid,
    subject_did: creatorDid,
    type: 'ticket.purchased',
    context_id: eventId,
    context_type: 'event',
    payload: { ticketId, amount, currency },
  }).catch((err) => log.error({ err: String(err) }, '[bus/attestation] ticket.purchased error'));
}

export async function onListingPurchased(payload: ListingPurchasedPayload): Promise<void> {
  const { buyerDid, sellerDid, listingId, amount } = payload;

  await emitAttestation({
    issuer_did: buyerDid,
    subject_did: sellerDid,
    type: 'listing.purchased',
    context_id: listingId,
    context_type: 'market',
    payload: { amount },
  }).catch((err) => log.error({ err: String(err) }, '[bus/attestation] listing.purchased error'));
}
