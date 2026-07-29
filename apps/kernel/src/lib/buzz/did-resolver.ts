/**
 * Buzz/Nostr DID attribution — write path and reverse resolver (#1413).
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
 *   [imajin-attestation] tags, then verifies them against the DB:
 *     1. Finds all non-revoked nostr-key-binding attestations for the claimed DID.
 *     2. Confirms payload.nostr_pubkey matches the event's signing pubkey.
 *     3. Recomputes the canonical digest and checks it against the tag value.
 *   Returns the Imajin DID on success, undefined on any mismatch or missing data.
 */

import { canonicalize, nostrAttestationDigest, bytesToHex } from '@imajin/auth';
import { db, attestations } from '@/src/db';
import { eq, and, isNull } from 'drizzle-orm';
import type { DidTags, NostrEvent } from './nostr-event';

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
 * Resolve the Imajin DID from a Buzz event's attribution tags.
 *
 * Verification chain:
 *   1. The event must carry both `[imajin-did, ...]` and
 *      `[imajin-attestation, ...]` tags.
 *   2. A non-revoked `imajin/nostr-key-binding` attestation for the claimed DID
 *      must exist in the database.
 *   3. The attestation's `payload.nostr_pubkey` must match the event's
 *      signing pubkey (event.pubkey).
 *   4. The attestation's canonical-payload digest must match the tag value.
 *
 * Returns the Imajin DID string when all checks pass, undefined otherwise.
 */
export async function resolveDidFromEvent(event: NostrEvent): Promise<string | undefined> {
  const didTag = event.tags.find((t) => t[0] === 'imajin-did');
  const attTag = event.tags.find((t) => t[0] === 'imajin-attestation');

  if (!didTag?.[1] || !attTag?.[1]) return undefined;

  const claimedDid = didTag[1];
  const claimedDigest = attTag[1];

  const rows = await db
    .select()
    .from(attestations)
    .where(
      and(
        eq(attestations.subjectDid, claimedDid),
        eq(attestations.type, 'imajin/nostr-key-binding'),
        isNull(attestations.revokedAt),
      ),
    );

  for (const att of rows) {
    // Step 3: verify the attestation binds this exact Nostr pubkey
    const claim = att.payload as { nostr_pubkey?: string } | null;
    if (claim?.nostr_pubkey !== event.pubkey) continue;

    // Step 4: verify the canonical-payload digest matches the tag
    if (digestForRow(att) !== claimedDigest) continue;

    return claimedDid;
  }

  return undefined;
}
