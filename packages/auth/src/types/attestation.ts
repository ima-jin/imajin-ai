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
  'pod.member.added',
  'pod.member.removed',
  'pod.role.changed',
  'group.created',
  'group.member.added',
  'group.member.removed',
  'group.member.left',
  'scope.onboard',
  'identity.created',
  'identity.verified.preliminary',
  'identity.verified.hard',
  'identity.verified.steward',
  'identity.verified.operator',
  'event.created',
  'handle.claimed',
  'ticket.purchased',
  'listing.created',
  'listing.purchased',
  'tip.granted',
  'app.authorized',
  'app.revoked',
  'document.created',
  'document.signed',
  'document.executed',
  'document.declined',
  'document.amended',
  'github_account',
  'contributor.issue.closed',
  'contributor.pr.merged',
  'contributor.rfc.authored',
  'contributor.review',
  'contributor.design',
  'email_verified',
  'phone_verified',
  'imajin/nostr-key-binding',
  'broker.release',
] as const;

export type AttestationType = typeof ATTESTATION_TYPES[number];

/**
 * Claim payload for the `imajin/nostr-key-binding` attestation type.
 *
 * A DID-key signs this to assert that the given Nostr public key
 * (nostr_pubkey / npub) belongs to or acts on behalf of the subject DID.
 */
export interface NostrKeyBindingClaim {
  /** Hex-encoded secp256k1 public key (32 bytes / 64 hex chars) */
  nostr_pubkey: string;
  /** Bech32-encoded npub (NIP-19) */
  npub: string;
  /** DID that ultimately controls the Nostr key (may differ from subject) */
  onBehalfOf?: string;
  /** Human-readable purpose, e.g. 'buzz-workspace-participation' */
  purpose: string;
  /** Unix epoch ms when the claim was issued */
  issued_at: number;
  /** Optional Unix epoch ms after which the binding expires */
  expires_at?: number;
}

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
