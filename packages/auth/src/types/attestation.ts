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
  'agent.turn.usage',
  'broker.release',

  // Intro-funnel vocabulary (#1885) — shared schema for matchmaking-style
  // intro funnels so any agent's funnel is signed, comparable, and
  // recomputable. Ordered: intro_proposed -> consent_given|consent_declined
  // -> intro_made -> conversation_happened. See packages/auth/src/intro-funnel.ts
  // for the envelope/evidence-grade/disclosure-scope mechanics built on top
  // of these types.
  'intro_proposed',
  'consent_given',
  'consent_declined',
  'intro_made',
  'conversation_happened',
] as const;

export type AttestationType = typeof ATTESTATION_TYPES[number];

/**
 * Attestation types that are minted automatically by the platform/kernel
 * node identity as mechanical audit records — e.g. `session.created`, written
 * by `emitSessionAttestation()` on every prod session start. These never
 * carry an `author_jws`, are never bilateral, and are never intended for
 * human countersignature.
 *
 * A denylist rather than an allowlist (#1822): the vast majority of
 * `ATTESTATION_TYPES` are legitimate, human-relevant claims (vouches,
 * receipts, document signing, etc.) whose "pending" vs. "not applicable"
 * status is already correctly derived from whether the row carries an
 * `author_jws`. Enumerating all of those as an allowlist would be far more
 * error-prone — any type accidentally left off would have its real,
 * legitimate pending-countersignature entries silently hidden — than
 * explicitly naming the small, known set of mechanical types that must be
 * excluded from any "pending your countersignature" view or query.
 */
export const MECHANICAL_ATTESTATION_TYPES = ['session.created', 'agent.turn.usage'] as const;

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
