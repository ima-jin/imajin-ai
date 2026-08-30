/**
 * Shared helpers for attestation route handlers.
 * Extracted to avoid duplication between the public and internal POST endpoints.
 */

import { verifyNostrSig, isDisclosureScope, DISCLOSURE_SCOPES, DEFAULT_DISCLOSURE_SCOPE } from '@imajin/auth';
import type { NostrKeyBindingClaim, DisclosureScope } from '@imajin/auth';
import { toOrigin } from '@/src/lib/http/public-origin';

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

  return {
    ok: true,
    envelope: {
      delegatorDid: (delegatorDidRaw as string | undefined) ?? null,
      disclosureScope,
      prevEventRef: (prevEventRefRaw as string | undefined) ?? null,
    },
  };
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
