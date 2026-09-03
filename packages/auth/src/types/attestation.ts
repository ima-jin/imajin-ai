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

  // External-agent onboarding (#1883) — minted by the platform node identity
  // at knock-accept time. Records a bring-your-own DID an external agent
  // claims (e.g. did:web:boardy.ai) as linkage to its did:imajin identity.
  // Never used as an auth basis — auth root stays homogeneous (did:imajin +
  // challenge-response); this is provenance only.
  'agent.external_identity',

  // Off-platform value-realization fact (#1886) — the intro-attribution
  // .fair template's second trigger class. One party claims value was
  // realized outside the platform (a deal closed, a hire made); the other
  // countersigns via the existing bilateral flow. Per #1885's money rule,
  // only the COUNTERSIGNED (bilateral) form may ever trigger a .fair
  // settlement — a lone `pending` claim is structurally inert. Not part of
  // the ordered intro-funnel chain (packages/auth/src/intro-funnel.ts) —
  // it is the outcome fact the funnel's provenance points at, referenced
  // via the existing generic `prev_event_ref` envelope field rather than a
  // funnel-specific one.
  'value_realized',

  // Agent Resource-Accounting Layer (#1147/#1148) — `usage.incurred` is the
  // per-call/per-row emitter-agnostic metering fact; `usage.rollup` is the
  // daily clock-rollup's one-per-(principal,window) summary. Both are
  // system-class (see MECHANICAL_ATTESTATION_TYPES below) — minted by the
  // node's own key about the agent's own resource consumption, never a
  // bilateral/human-signed claim.
  'usage.incurred',
  'usage.rollup',

  // Key recovery (#1250 Phase 1 — the self-custody recovery-code floor).
  // Both are system-class (see MECHANICAL_ATTESTATION_TYPES below): minted
  // by the platform node identity as a mechanical audit record, never a
  // bilateral/human-signed claim. `recovery.codes.generated` carries only a
  // count, never the codes themselves. `recovery.redeemed` records that a
  // recovery-authorized rotation happened — the honesty disclosure (this
  // path is server-verified, not trustless) lives in the API response, not
  // in the attestation payload.
  'recovery.codes.generated',
  'recovery.redeemed',
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
export const MECHANICAL_ATTESTATION_TYPES = [
  'session.created',
  'agent.turn.usage',
  'agent.external_identity',
  // #1147/#1148 attestationClass: 'system' facts — see ATTESTATION_TYPES above.
  'usage.incurred',
  'usage.rollup',
  // #1250 Phase 1 — see ATTESTATION_TYPES above.
  'recovery.codes.generated',
  'recovery.redeemed',
] as const;

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
