/**
 * Shared helpers for attestation route handlers.
 * Extracted to avoid duplication between the public and internal POST endpoints.
 */

import { verifyNostrSig, isDisclosureScope, DISCLOSURE_SCOPES, DEFAULT_DISCLOSURE_SCOPE, capabilityForDelegatedAttestationType } from '@imajin/auth';
import type { NostrKeyBindingClaim, DisclosureScope } from '@imajin/auth';
import { toOrigin } from '@/src/lib/http/public-origin';
import { introspectGrant } from '@/src/lib/auth/grants';
import { db, attestations } from '@/src/db';
import type { Attestation } from '@/src/db';
import { eq } from 'drizzle-orm';

/**
 * Resolve an issued_at field from a request body to a Unix timestamp in ms.
 * Accepts a numeric ms timestamp, an ISO string, or undefined (defaults to now).
 */
export function resolveIssuedAt(value: unknown): number {
  if (!value) return Date.now();
  if (typeof value === 'number') return value;
  return new Date(value as string).getTime();
}

/**
 * Derive the calling app's origin from the request's `Origin` header, for the
 * `attestation.created` event payload (#1820).
 *
 * Only browser-issued cross-origin requests reliably carry an `Origin` header —
 * server-to-service calls (e.g. the internal attestation route) typically do
 * not, so this legitimately returns `undefined` there. `toOrigin()` also
 * rejects a malformed header value rather than propagating garbage.
 */
export function deriveOriginUrl(request: { headers: { get(name: string): string | null } }): string | undefined {
  return toOrigin(request.headers.get('origin') ?? undefined) ?? undefined;
}

/**
 * Envelope fields for the intro-funnel schema (#1885) — delegator_did,
 * disclosure_scope, prev_event_ref. These ride inside the already-signed
 * `payload` object rather than as new top-level canonicalize() inputs, so
 * adding them is not a breaking wire-format change for existing callers.
 * Both attestation-creation routes mirror them into dedicated indexed
 * columns after validating here.
 */
export interface EnvelopeFields {
  delegatorDid: string | null;
  disclosureScope: DisclosureScope;
  prevEventRef: string | null;
  // Amendment-by-supersession (#1790): the bilateral attestation this one
  // proposes to amend, if any. Deliberately kept separate from prevEventRef
  // both here and at the DB level (see attestations.supersedes) — a funnel
  // envelope ref must never trip supersession logic.
  supersedes: string | null;
}

export type EnvelopeValidationResult =
  | { ok: true; envelope: EnvelopeFields }
  | { ok: false; error: string };

/** Extract and validate the envelope fields carried inside `payload`. */
export function resolveEnvelopeFields(payload: unknown): EnvelopeValidationResult {
  const source: Record<string, unknown> =
    payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};

  const delegatorDidRaw = source.delegator_did;
  if (delegatorDidRaw !== undefined && delegatorDidRaw !== null && typeof delegatorDidRaw !== 'string') {
    return { ok: false, error: 'payload.delegator_did must be a string' };
  }

  let disclosureScope: DisclosureScope = DEFAULT_DISCLOSURE_SCOPE;
  const disclosureScopeRaw = source.disclosure_scope;
  if (disclosureScopeRaw !== undefined && disclosureScopeRaw !== null) {
    if (typeof disclosureScopeRaw !== 'string' || !isDisclosureScope(disclosureScopeRaw)) {
      return { ok: false, error: `payload.disclosure_scope must be one of: ${DISCLOSURE_SCOPES.join(', ')}` };
    }
    disclosureScope = disclosureScopeRaw;
  }

  const prevEventRefRaw = source.prev_event_ref;
  if (prevEventRefRaw !== undefined && prevEventRefRaw !== null && typeof prevEventRefRaw !== 'string') {
    return { ok: false, error: 'payload.prev_event_ref must be a string' };
  }

  const supersedesRaw = source.supersedes;
  if (supersedesRaw !== undefined && supersedesRaw !== null && typeof supersedesRaw !== 'string') {
    return { ok: false, error: 'payload.supersedes must be a string' };
  }

  return {
    ok: true,
    envelope: {
      delegatorDid: (delegatorDidRaw as string | undefined) ?? null,
      disclosureScope,
      prevEventRef: (prevEventRefRaw as string | undefined) ?? null,
      supersedes: (supersedesRaw as string | undefined) ?? null,
    },
  };
}

/**
 * Thrown when the countersign-time re-check of a `supersedes` reference
 * fails inside `db.transaction()` (see countersign/route.ts) — the
 * transaction rolls back and the route maps this to an HTTP response.
 * Mirrors the typed-error-with-status convention already used by
 * `VaultDelegationError` (src/lib/vault/errors.ts) and `WarpApiError`
 * (src/lib/warp/errors.ts).
 */
export class SupersessionError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'SupersessionError';
    this.status = status;
  }
}

export type SupersessionEligibilityTarget = Pick<Attestation, 'issuerDid' | 'subjectDid' | 'attestationStatus'>;

export type SupersessionEligibilityResult = { ok: true } | { ok: false; error: string };

/**
 * Amendment-by-supersession (#1790) is only accepted when the proposer is a
 * party (issuer or subject) to the referenced attestation, and that
 * attestation is currently bilateral — supersession only applies
 * post-bilateral, per the design. A `contextId`/`payload.amends`-style
 * reference is not enough on its own (see migrations/0109's rationale).
 *
 * Pure and DB-independent so it can run both at creation time (against a
 * freshly `db.select()`-ed row) and again at countersign time inside
 * `db.transaction()` against a `tx.select()`-ed row — the same rule can
 * never drift between the two call sites.
 */
export function checkSupersessionEligibility(
  target: SupersessionEligibilityTarget,
  proposerDid: string,
): SupersessionEligibilityResult {
  const isParty = target.issuerDid === proposerDid || target.subjectDid === proposerDid;
  if (!isParty) {
    return {
      ok: false,
      error: `supersedes must reference an attestation "${proposerDid}" is a party to (issuer or subject)`,
    };
  }
  if (target.attestationStatus !== 'bilateral') {
    return {
      ok: false,
      error: `supersedes must reference a bilateral attestation (found "${target.attestationStatus ?? 'legacy (no status)'}")`,
    };
  }
  return { ok: true };
}

export type SupersedesValidationResult = { ok: true } | { ok: false; error: string };

/**
 * Creation-time validation for a `supersedes` reference: it must resolve to
 * an existing attestation, and `checkSupersessionEligibility` must pass for
 * `proposerDid` (the new attestation's issuer). Shared by both
 * attestation-creation routes so the check can never drift between them.
 */
export async function validateSupersedesReference(
  supersedes: string,
  proposerDid: string,
): Promise<SupersedesValidationResult> {
  const [target] = await db.select().from(attestations).where(eq(attestations.id, supersedes)).limit(1);
  if (!target) {
    return { ok: false, error: `supersedes "${supersedes}" does not reference an existing attestation` };
  }
  return checkSupersessionEligibility(target, proposerDid);
}

/** A minimal projection of an attestation for chain-history responses. */
export interface SupersessionChainLink {
  id: string;
  attestationStatus: string | null;
  supersedes: string | null;
}

export interface AttestationHistoryResult {
  /** The full v1<-v2<-... chain, root (v1) first, most recent last. */
  chain: SupersessionChainLink[];
  /** Still-`pending` amendments proposed against the chain's current end — #1790's "a pending amendment against a bilateral record must be queryable" (open-dispute visibility). */
  openDisputes: SupersessionChainLink[];
}

// Defensive cap on chain-walk hops — creation-time + countersign-time
// validation only ever let a `supersedes` link point at a bilateral row, so
// a cycle should be structurally impossible, but this bounds the query
// fan-out regardless.
const MAX_SUPERSESSION_CHAIN_HOPS = 1000;

function toChainLink(row: Attestation): SupersessionChainLink {
  return { id: row.id, attestationStatus: row.attestationStatus, supersedes: row.supersedes };
}

/**
 * Read-side chain walk for amendment-by-supersession (#1790). Given any
 * attestation id in a v1<-v2<-... chain, returns the whole chain (walking
 * `supersedes` backward to the root, then forward through whichever
 * successor actually reached bilateral/superseded) plus any still-pending
 * amendments proposed against the chain's current end.
 *
 * Reads default to operative records elsewhere (GET /auth/api/attestations
 * excludes `superseded` unless explicitly asked for); this is the
 * counterpart history view that shows the whole chain regardless of status.
 */
export async function resolveAttestationHistory(attestationId: string): Promise<AttestationHistoryResult | null> {
  const [start] = await db.select().from(attestations).where(eq(attestations.id, attestationId)).limit(1);
  if (!start) return null;

  const backward: Attestation[] = [start];
  let current = start;
  for (let hops = 0; hops < MAX_SUPERSESSION_CHAIN_HOPS && current.supersedes; hops++) {
    const [predecessor] = await db.select().from(attestations).where(eq(attestations.id, current.supersedes)).limit(1);
    if (!predecessor) break;
    backward.push(predecessor);
    current = predecessor;
  }
  const chain = backward.reverse();

  let tail = chain[chain.length - 1];
  let openDisputes: Attestation[] = [];
  for (let hops = 0; hops < MAX_SUPERSESSION_CHAIN_HOPS; hops++) {
    const successors = await db.select().from(attestations).where(eq(attestations.supersedes, tail.id));
    const winner = successors.find((row) => row.attestationStatus === 'bilateral' || row.attestationStatus === 'superseded');
    if (!winner) {
      openDisputes = successors.filter((row) => row.attestationStatus === 'pending');
      break;
    }
    chain.push(winner);
    tail = winner;
  }

  return { chain: chain.map(toChainLink), openDisputes: openDisputes.map(toChainLink) };
}

export type DelegationVerificationResult =
  | { ok: true; grantId: string | null }
  | { ok: false; error: string };

/**
 * Verify that a live (unexpired, unrevoked) delegation grant exists from
 * `delegatorDid` to `issuerDid` covering the capability implied by `type`,
 * whenever an attestation asserts delegated authority via
 * payload.delegator_did (#1895, #1897 — the RFC #1881 revocation finding:
 * a self-asserted delegator_did was never checked against a live grant, so
 * a revoked or never-granted agent could still mint a valid-looking
 * "delegated" attestation).
 *
 * Self-attestation — `delegatorDid` absent or equal to `issuerDid` — needs
 * no grant and resolves immediately with `grantId: null`.
 *
 * Fails closed: an attestation type with no defined delegation capability,
 * or a lookup that finds no live grant from exactly this delegator to this
 * issuer, is rejected rather than accepted on an unverified claim. Shared
 * by both attestation-creation routes so the check can never drift between
 * them.
 */
export async function verifyDelegatedAttestation(params: {
  delegatorDid: string | null;
  issuerDid: string;
  subjectDid: string;
  type: string;
}): Promise<DelegationVerificationResult> {
  const { delegatorDid, issuerDid, subjectDid, type } = params;
  if (!delegatorDid || delegatorDid === issuerDid) {
    return { ok: true, grantId: null };
  }

  const capability = capabilityForDelegatedAttestationType(type);
  if (!capability) {
    return { ok: false, error: `Attestation type "${type}" does not support payload.delegator_did` };
  }

  const introspection = await introspectGrant({ agentDid: issuerDid, capability, targetDid: subjectDid, delegatorDid });
  if (!introspection.authorized || !introspection.grantId) {
    return {
      ok: false,
      error: `No live delegation grant from "${delegatorDid}" to "${issuerDid}" covers "${capability}"`,
    };
  }

  return { ok: true, grantId: introspection.grantId };
}

export type NostrValidationResult =
  | { ok: true; nostrSigToStore: string }
  | { ok: false; error: string };

/**
 * Validate the dual-signed nostr-key-binding proof.
 * Returns { ok: true, nostrSigToStore } on success or { ok: false, error } on failure.
 */
export function validateNostrKeyBinding(
  nostrSig: unknown,
  payload: unknown,
  canonicalPayload: string
): NostrValidationResult {
  if (!nostrSig || typeof nostrSig !== 'string') {
    return { ok: false, error: 'nostr_sig required for imajin/nostr-key-binding' };
  }
  const claim = payload as NostrKeyBindingClaim | null;
  if (!claim?.nostr_pubkey || typeof claim.nostr_pubkey !== 'string') {
    return { ok: false, error: 'payload.nostr_pubkey required for imajin/nostr-key-binding' };
  }
  if (!verifyNostrSig(nostrSig, canonicalPayload, claim.nostr_pubkey)) {
    return { ok: false, error: 'Invalid nostr_sig — Nostr key control not proven' };
  }
  return { ok: true, nostrSigToStore: nostrSig };
}
