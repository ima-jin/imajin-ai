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

  // Manual/backfill `usage.billed` line item (#2030, widening #1951 D4).
  // Minted by the platform node identity when POST /usage/api/billed writes
  // a line item on the principal's own DID — binds the vendor/period/amount
  // (and, when present, the evidence asset's content hash) to a durable
  // signed record. System-class (see MECHANICAL_ATTESTATION_TYPES below):
  // this is proof-of-history for the write, never a bilateral claim.
  'usage.billed',

  // Device tracking & new-device login alerts (#306) — minted by the
  // platform node identity whenever a session records a device fingerprint
  // it has not seen before for that DID (including the very first device).
  // Proof-of-history for the login itself, not a gate — see
  // apps/kernel/src/lib/auth/emit-device-attestation.ts.
  'session.device.new',
  
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

  // Ingestion attestations (#1750/#2021) — minted by a corpus service's own
  // service DID (never the platform node identity) each time it ingests a
  // batch of ThreadDocuments, then forwarded to the kernel's durable
  // auth.attestations as the cross-service record. See
  // apps/corpus/src/engine/attestation.ts for the payload shape
  // (source/corpusDid/ingesterDid/contentHash/threadCount/timestamp) and
  // spikes/corpus-identity/README.md's "Ingestion attestation schema" section.
  'corpus.ingested',

  // App registry admin mutations (#1990) — minted by the platform node
  // identity when an admin registers, rotates the keypair of, or revokes an
  // app's registry.apps row (POST/PATCH/DELETE /api/admin/registry/apps/**).
  // System-class (see MECHANICAL_ATTESTATION_TYPES below): this is the
  // signed audit trail for the mutation itself, never a bilateral/
  // human-countersigned claim. Distinct from the pre-existing
  // 'app.authorized' / 'app.revoked', which record a USER's own consent
  // grant to (or withdrawal from) a third-party app — these three record
  // the ADMIN's registry action on the app record itself.
  'registry.app.registered',
  'registry.app.rotated',
  'registry.app.revoked',

  // Withdrawal-intent reconciliation (#2172) — minted by the platform node
  // identity whenever the reconciliation sweep classifies a rail transfer
  // and a withdrawal intent as NOT matching (either an external transfer
  // with no completed ledger row, or a pending intent that has aged past
  // the timeout with no matching external transfer). System-class (see
  // MECHANICAL_ATTESTATION_TYPES below): a durable, signed proposal for
  // operator review, never a bilateral/human-signed claim. The reconciler
  // itself never mutates a balance or intent status — see
  // apps/kernel/src/lib/pay/reconciliation.ts.
  'pay.reconciliation.discrepancy',

  // pay.payment_request lifecycle facts (#2206/#2208/#2209) — an invoice /
  // money request as a first-class receivable on the business DID.
  // `issued` and manual `settled` are minted signed by the issuer DID
  // (never the platform node identity); a `settled` for an on-platform
  // Stripe settlement (#2209) is kernel-signed instead (no human asserted
  // it, the webhook did) — see
  // apps/kernel/src/lib/pay/payment-requests/attestations.ts. Both bind
  // the request's content_hash, never bytes. System-class in the sense
  // that they are always unilateral/mechanical (see
  // MECHANICAL_ATTESTATION_TYPES below): never bilateral, never carrying
  // an author_jws, never awaiting a countersignature.
  'payment_request.issued',
  'payment_request.settled',

  // pay.payment_request recipient re-pointing (#2210) — minted mechanically
  // by the platform node identity when a claimable-stub recipient
  // (recipient_stub_id) connects to the issuer (accepts the invite / claims
  // the stub, whichever ordering the recipient chose), re-pointing the
  // request to a resolved recipient_did. System-class (see
  // MECHANICAL_ATTESTATION_TYPES below): never a rewrite of the prior
  // `issued`/`settled` attestations, always its own new record.
  'payment_request.recipient_claimed',
  // #2242 — minted mechanically when a vault keypair is born in-vault or a
  // minted key's grant is revoked. See ATTESTATION_TYPES above.
  'vault.key.minted',
  'vault.key.revoked',
  // #2251 — per-principal agent-reach exchange. Minted mechanically (kernel
  // node key) on every reach attempt, answered or denied: binds the foreign
  // agent DID, the foreign-principal stub DID it declared `onBehalfOf`, the
  // target principal DID, and a transcript hash. The payload embeds the
  // foreign agent's own signature over the transcript (verified before the
  // gate is evaluated), so "both sides signed" is checkable by any third
  // party from public DID documents alone, without either party trusting
  // this record. System-class (see MECHANICAL_ATTESTATION_TYPES below):
  // never bilateral, never awaiting a countersignature.
  'agent.reach',
  // #2247 — minted mechanically when a minted key's grant is withdrawn
  // (revoke tier 'withdraw': stops future fetches without tombstoning the
  // vault_minted_keys record itself, distinct from 'vault.key.revoked').
  // See ATTESTATION_TYPES above.
  'vault.key.withdrawn',
  // #2245 — minted mechanically, exactly once, the first time the kernel
  // self-provisions an internal secret (e.g. the foreign-principal-stub
  // pepper) that has no active vault_delegation_grants row yet for its
  // purpose. Binds only purpose/grantId/contentHash — never the generated
  // bytes. See apps/kernel/src/lib/vault/internal-secret.ts.
  'vault.secret.generated',
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
  // #2030 — see ATTESTATION_TYPES above.
  'usage.billed',
  // #306 — see ATTESTATION_TYPES above.
  'session.device.new',
  // #1250 Phase 1 — see ATTESTATION_TYPES above.
  'recovery.codes.generated',
  'recovery.redeemed',
  // #1750/#2021 — minted mechanically by a corpus service's own key on
  // every ingestion batch, never a bilateral/human-signed claim. See
  // ATTESTATION_TYPES above.
  'corpus.ingested',
  // #1990 — minted mechanically by the platform node identity on every
  // admin registry mutation. See ATTESTATION_TYPES above.
  'registry.app.registered',
  'registry.app.rotated',
  'registry.app.revoked',
  // #2172 — minted mechanically by the platform node identity for every
  // withdrawal reconciliation discrepancy. See ATTESTATION_TYPES above.
  'pay.reconciliation.discrepancy',
  // #2206/#2208 — minted mechanically (unilateral, never a bilateral/
  // human-countersigned claim) whenever a payment_request is issued or
  // settled. Signed by the issuer DID, not the platform node identity —
  // see ATTESTATION_TYPES above.
  'payment_request.issued',
  'payment_request.settled',
  // #2210 — minted mechanically by the platform node identity when a
  // claimable-stub recipient resolves to a recipient_did. See
  // ATTESTATION_TYPES above.
  'payment_request.recipient_claimed',
  // #2242 — minted mechanically when a vault keypair is born in-vault or a
  // minted key's grant is revoked. See ATTESTATION_TYPES above.
  'vault.key.minted',
  'vault.key.revoked',
  // #2251 — minted mechanically by the kernel node key on every reach
  // attempt (answered or denied). See ATTESTATION_TYPES above.
  'agent.reach',
  // #2247 — minted mechanically when a minted key's grant is withdrawn.
  // See ATTESTATION_TYPES above.
  'vault.key.withdrawn',
  // #2245 — minted mechanically, exactly once, on first-boot self-
  // provisioning of an internal secret. See ATTESTATION_TYPES above.
  'vault.secret.generated',
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
