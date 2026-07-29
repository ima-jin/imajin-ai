/**
 * Shared helpers for attestation route handlers.
 * Extracted to avoid duplication between the public and internal POST endpoints.
 */

import { verifyNostrSig } from '@imajin/auth';
import type { NostrKeyBindingClaim } from '@imajin/auth';

/**
 * Resolve an issued_at field from a request body to a Unix timestamp in ms.
 * Accepts a numeric ms timestamp, an ISO string, or undefined (defaults to now).
 */
export function resolveIssuedAt(value: unknown): number {
  if (!value) return Date.now();
  if (typeof value === 'number') return value;
  return new Date(value as string).getTime();
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
