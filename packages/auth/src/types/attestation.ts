/**
 * Attestation Types
 *
 * Vocabulary of attestation types issued on the Imajin network.
 */

export const ATTESTATION_TYPES = [
  'event.attendance',
  'institution.verified',
  'vouch.given',
  'vouch.received',
  'flag.yellow',
  'flag.cleared',
  'transaction.settled',
  'customer',
  'connection.invited',
  'connection.accepted',
  'vouch',
  'session.created',
  'learn.enrolled',
  'learn.completed',
] as const;

export type AttestationType = typeof ATTESTATION_TYPES[number];

export interface Attestation {
  id: string;                    // att_xxx
  issuerDid: string;
  subjectDid: string;
  type: AttestationType;
  contextId?: string | null;     // e.g. event DID
  contextType?: string | null;   // e.g. 'event'
  payload?: Record<string, unknown> | null;
  signature: string;             // Ed25519 hex over canonicalized payload
  issuedAt: Date;
  expiresAt?: Date | null;
  revokedAt?: Date | null;
}
