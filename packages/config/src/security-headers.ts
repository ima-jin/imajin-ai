import { ALLOWED_FRAME_ORIGINS } from './cors';

type HeaderEntry = { key: string; value: string };

/**
 * Build the frame-ancestors directive value.
 * Mirrors isAllowedOrigin(): includes localhost:* in non-prod so local
 * hub-iframe development works without disabling frame protection.
 */
function buildFrameAncestors(): string {
  const local = process.env.NODE_ENV !== 'production' ? ' http://localhost:*' : '';
  return `frame-ancestors 'self' ${ALLOWED_FRAME_ORIGINS}${local}`;
}

/**
 * Tier 1 — hard deny framing.
 * Use on credential and auth-sensitive pages that must never be embedded.
 */
export function tier1Headers(): HeaderEntry[] {
  return [
    { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
    { key: 'X-Frame-Options', value: 'DENY' },
  ];
}

/**
 * Tier 2 — allow framing by Imajin origins only.
 * Use on routes embedded by the auth hub (service dashboards, document viewer, surveys).
 * Does not include X-Frame-Options — it cannot express an allow-list, and SAMEORIGIN
 * would break cross-subdomain framing. CSP frame-ancestors does the work here.
 */
export function tier2Headers(): HeaderEntry[] {
  return [{ key: 'Content-Security-Policy', value: buildFrameAncestors() }];
}

/**
 * Tier 3 — baseline hardening.
 * Safe to apply on every route in every app.
 */
export function tier3Headers(): HeaderEntry[] {
  return [
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  ];
}
