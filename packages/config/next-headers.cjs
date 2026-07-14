'use strict';

/**
 * Security-header helpers for next.config.js (CommonJS bridge).
 *
 * The frame-ancestors value is derived from ALLOWED_FRAME_ORIGINS in src/cors.ts
 * and the localhost dev behaviour mirrors isAllowedOrigin() in the same file.
 * If the allowed-origin set changes, update src/cors.ts (ORIGIN_PATTERN +
 * ALLOWED_FRAME_ORIGINS) and the constant below together.
 */

// Mirrors ALLOWED_FRAME_ORIGINS in src/cors.ts
const ALLOWED_FRAME_ORIGINS = 'https://*.imajin.ai https://imajin.ai';

/**
 * Build the frame-ancestors directive value.
 * Adds localhost:* in non-prod, mirroring isAllowedOrigin().
 */
function buildFrameAncestors() {
  const local = process.env.NODE_ENV !== 'production' ? ' http://localhost:*' : '';
  return `frame-ancestors 'self' ${ALLOWED_FRAME_ORIGINS}${local}`;
}

/**
 * Tier 1 — hard deny framing.
 * Use on credential and auth-sensitive pages that must never be embedded.
 * @returns {Array<{key: string, value: string}>}
 */
function tier1Headers() {
  return [
    { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
    { key: 'X-Frame-Options', value: 'DENY' },
  ];
}

/**
 * Tier 2 — allow framing by Imajin origins only.
 * Use on routes embedded by the auth hub (service dashboards, document viewer, surveys).
 * Intentionally omits X-Frame-Options — it cannot express an allow-list.
 * @returns {Array<{key: string, value: string}>}
 */
function tier2Headers() {
  return [{ key: 'Content-Security-Policy', value: buildFrameAncestors() }];
}

/**
 * Tier 3 — baseline hardening. Safe to apply on every route in every app.
 * @returns {Array<{key: string, value: string}>}
 */
function tier3Headers() {
  return [
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  ];
}

module.exports = { tier1Headers, tier2Headers, tier3Headers };
