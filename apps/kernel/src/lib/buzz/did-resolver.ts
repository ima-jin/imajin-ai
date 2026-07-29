/**
 * Buzz/Nostr DID attribution — write path and reverse resolver (#1413, #1415).
 *
 * Every NIP-29 kind:9 event emitted by the Imajin agent carries two extra tags
 * that bind the signing Nostr key back to a sovereign Imajin DID:
 *
 *   [imajin-did, <ownerDid>]
 *   [imajin-attestation, <sha256hex(canonicalPayload)>]
 *
 * The digest is the SHA-256 of the canonical JSON form of the
 * `imajin/nostr-key-binding` attestation stored in the database — the same
 * canonical form the issuer signed with their Ed25519 key.
 *
 * Write path  → loadDidTags(ownerDid)
 *   Queries the DB for the owner's non-revoked nostr-key-binding attestation,
 *   recomputes the canonical payload digest, and returns a DidTags object ready
 *   to pass to buildKind9Event.  Returns undefined when no binding exists.
 *
 * Read path   → resolveDidFromEvent(event)
 *   Given an inbound Buzz event, extracts the [imajin-did] and
 *   [imajin-attestation] tags, then verifies them against the DB —
 *   including revoked attestations so historical events are handled honestly:
 *     1. Finds all nostr-key-binding attestations for the claimed DID
 *        (active and revoked).
 *     2. Confirms payload.nostr_pubkey matches the event's signing pubkey.
 *     3. Recomputes the canonical digest and checks it against the tag value.
 *     4. Prefers an active binding; falls back to a revoked one.
 *   Returns a ResolveResult:
 *     { did, status: 'active' }  — binding is currently valid
 *     { did, status: 'revoked',
 *       revokedAt, validAtEventTime }  — binding was revoked;
 *       validAtEventTime=true means the event predates the revocation
 *       ("signed at T under grant since-revoked")
 *     null  — no matching binding found
 */

import { canonicalize, nostrAttestationDigest, bytesToHex } from '@imajin/auth';
import { db, attestations } from '@/src/db';
import { eq, and, isNull } from 'drizzle-orm';
import type { DidTags, NostrEvent } from './nostr-event';

// ── Revocation-aware result type ─────────────────────────────────────────────

/**
 * Result of resolving a Buzz event's DID attribution tags (#1415).
 *
 * - `active`  — the nostr-key-binding is current; authority is intact.
 * - `revoked` — the binding was revoked at `revokedAt`.
 *   `validAtEventTime` is true when the event was signed BEFORE revocation
 *   (i.e. it was authoritative when sent, but the grant has since lapsed).
 *   This is the "signed at T under grant since-revoked" case the AC describes.
 * - `null`    — no matching binding was found at all.
 */
export type ResolveResult =
  | { did: string; status: 'active' }
  | { did: string; status: 'revoked'; revokedAt: Date; validAtEventTime: boolean }
  | null;

// ── Canonical payload helpers ─────────────────────────────────────────────────

type AttestationRow = typeof attestations.$inferSelect;

/**
 * Rebuild the canonical JSON string for an attestation row — the same form
 * that was signed when the attestation was issued.
 */
function canonicalPayloadForRow(att: AttestationRow): string {
  return canonicalize({
    subject_did: att.subjectDid,
    type: att.type,
    context_id: att.contextId ?? null,
    context_type: att.contextType ?? null,
    payload: att.payload ?? null,
    issued_at: att.issuedAt.getTime(),
  });
}

/**
 * Compute the SHA-256 hex digest of an attestation row's canonical payload.
 */
function digestForRow(att: AttestationRow): string {
  const digestBytes = nostrAttestationDigest(canonicalPayloadForRow(att));
  return bytesToHex(digestBytes);
}

// ── Write path ────────────────────────────────────────────────────────────────

/**
 * Load the DidTags for ownerDid from their non-revoked
 * `imajin/nostr-key-binding` attestation.
 *
 * Returns a DidTags object (ready to pass to buildKind9Event) when a valid
 * binding exists, or undefined when no binding has been recorded yet.
 */
export async function loadDidTags(ownerDid: string): Promise<DidTags | undefined> {
  const [att] = await db
    .select()
    .from(attestations)
    .where(
      and(
        eq(attestations.subjectDid, ownerDid),
        eq(attestations.type, 'imajin/nostr-key-binding'),
        isNull(attestations.revokedAt),
      ),
    )
    .limit(1);

  if (!att) return undefined;

  return {
    ownerDid,
    attestationDigest: digestForRow(att),
  };
}

// ── Read path (reverse resolver) ──────────────────────────────────────────────

/**
 * Resolve the Imajin DID from a Buzz event's attribution tags (#1413, #1415).
 *
 * Verification chain:
 *   1. The event must carry both `[imajin-did, ...]` and
 *      `[imajin-attestation, ...]` tags.
 *   2. All `imajin/nostr-key-binding` attestations for the claimed DID are
 *      fetched — including revoked ones — so historical events are not lost.
 *   3. The attestation's `payload.nostr_pubkey` must match the event's
 *      signing pubkey (event.pubkey).
 *   4. The attestation's canonical-payload digest must match the tag value.
 *   5. Active bindings win; revoked bindings are returned only when no active
 *      match exists.
 *
 * Returns a ResolveResult: active, revoked (with validAtEventTime flag), or null.
 */
export async function resolveDidFromEvent(event: NostrEvent): Promise<ResolveResult> {
  const didTag = event.tags.find((t) => t[0] === 'imajin-did');
  const attTag = event.tags.find((t) => t[0] === 'imajin-attestation');

  if (!didTag?.[1] || !attTag?.[1]) return null;

  const claimedDid = didTag[1];
  const claimedDigest = attTag[1];

  // Fetch all attestations — active and revoked — so we can report on both.
  const rows = await db
    .select()
    .from(attestations)
    .where(
      and(
        eq(attestations.subjectDid, claimedDid),
        eq(attestations.type, 'imajin/nostr-key-binding'),
      ),
    );

  let revokedResult: Extract<ResolveResult, { status: 'revoked' }> | undefined;

  for (const att of rows) {
    // Step 3: verify the attestation binds this exact Nostr pubkey
    const claim = att.payload as { nostr_pubkey?: string } | null;
    if (claim?.nostr_pubkey !== event.pubkey) continue;

    // Step 4: verify the canonical-payload digest matches the tag
    if (digestForRow(att) !== claimedDigest) continue;

    if (att.revokedAt === null) {
      // Active binding — return immediately; no need to check further.
      return { did: claimedDid, status: 'active' };
    }

    // Revoked binding — keep it as a candidate but prefer an active one.
    // validAtEventTime: the event was signed before the grant was revoked
    // ("signed at T under grant since-revoked" — honest history, not authority).
    revokedResult = {
      did: claimedDid,
      status: 'revoked',
      revokedAt: att.revokedAt,
      validAtEventTime: event.created_at * 1000 < att.revokedAt.getTime(),
    };
  }

  return revokedResult ?? null;
}
