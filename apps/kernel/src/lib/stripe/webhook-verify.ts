/**
 * Stripe webhook signature verification (#1785).
 *
 * Every Stripe webhook delivery carries a `Stripe-Signature` header of the
 * shape `t=<timestamp>,v1=<signature>[,v0=<signature>]` — the hex-encoded
 * HMAC-SHA256 of `${timestamp}.${rawBody}`, computed with the endpoint's own
 * signing secret (returned once by Stripe when the webhook endpoint is
 * created — see `connector.ts`). This mirrors Stripe's own
 * `stripe.webhooks.constructEvent` verification exactly, so this kernel never
 * depends on the `stripe` SDK just to check a signature.
 *
 * Two independent checks, both fail-closed:
 *   1. Signature match — proves the body was not tampered with and really
 *      was signed with this owner's signing secret.
 *   2. Timestamp tolerance — proves the delivery is fresh. Without this, a
 *      captured valid signature + body pair could be replayed indefinitely;
 *      Stripe's own SDK defaults to a 300s tolerance for the same reason.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Default replay tolerance, matching Stripe's own SDK default (5 minutes). */
export const DEFAULT_TOLERANCE_SECONDS = 300;

export type StripeSignatureVerification =
  | { ok: true }
  | { ok: false; reason: 'missing_header' | 'malformed_header' | 'signature_mismatch' | 'timestamp_out_of_tolerance' };

/** Parse `t=...,v1=...[,v0=...]` into its timestamp and every `v1` signature present. */
function parseSignatureHeader(header: string): { timestamp: string; v1Signatures: string[] } | null {
  let timestamp: string | undefined;
  const v1Signatures: string[] = [];

  for (const part of header.split(',')) {
    const [key, value] = part.split('=', 2);
    if (key === 't' && value) timestamp = value;
    if (key === 'v1' && value) v1Signatures.push(value);
  }

  if (!timestamp || v1Signatures.length === 0) return null;
  return { timestamp, v1Signatures };
}

/** Constant-time compare of two hex signature strings, guarding the length mismatch case. */
function signaturesMatch(expectedHex: string, actualHex: string): boolean {
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = Buffer.from(actualHex, 'hex');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/**
 * Verify a `Stripe-Signature` header against the raw request body and the
 * endpoint's signing secret.
 *
 * `rawBody` MUST be the exact, unmodified request body bytes (as text) — the
 * HMAC is computed over those exact bytes, same requirement as every other
 * webhook verifier in this codebase (see `quickbooks/webhook-verify.ts`).
 */
export function verifyStripeWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  signingSecret: string,
  options: { toleranceSeconds?: number; now?: number } = {},
): StripeSignatureVerification {
  if (!signatureHeader) {
    return { ok: false, reason: 'missing_header' };
  }

  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed) {
    return { ok: false, reason: 'malformed_header' };
  }
  const { timestamp, v1Signatures } = parsed;

  const expected = createHmac('sha256', signingSecret)
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest('hex');

  const signatureValid = v1Signatures.some((sig) => signaturesMatch(expected, sig));
  if (!signatureValid) {
    return { ok: false, reason: 'signature_mismatch' };
  }

  // Replay protection: reject a genuinely-signed body/signature pair whose
  // timestamp has aged out of tolerance, in either direction (stale replay or
  // a clock skewed too far into the future).
  const toleranceSeconds = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
  const eventSeconds = Number(timestamp);
  if (!Number.isFinite(eventSeconds) || Math.abs(nowSeconds - eventSeconds) > toleranceSeconds) {
    return { ok: false, reason: 'timestamp_out_of_tolerance' };
  }

  return { ok: true };
}
