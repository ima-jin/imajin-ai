import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { OAuthStateHelpers } from '../connector-oauth-state';

/**
 * Shared contract for `createOAuthStateHelpers` (#2144 dedup) — every
 * connector's own `oauth-state.test.ts` (github, quickbooks, google, ...)
 * used to hand-copy the identical six sign/verify/tamper/expiry cases, since
 * the underlying factory is generic and each wrapper is a one-line
 * `createOAuthStateHelpers('<connector>_state')`. Declaring the cases once
 * here is what keeps a new connector's oauth-state test a same-shape call
 * instead of another near-identical ~50-line clone (SonarCloud CPD flags
 * exactly this pattern once enough connectors pile up).
 *
 * Call this INSIDE the connector's own top-level `describe(...)` block, or as
 * the file's only top-level statement — it registers its own nested
 * `describe`/`it`s and manages `AUTH_PRIVATE_KEY` + fake timers itself.
 */
export function describeOAuthStateContract(
  connectorLabel: string,
  helpers: Pick<OAuthStateHelpers, 'signState' | 'verifyState'>,
  returnToPath: string,
): void {
  const { signState, verifyState } = helpers;
  const OWNER = 'did:imajin:jin';

  describe(`${connectorLabel} oauth-state (shared createOAuthStateHelpers contract)`, () => {
    beforeEach(() => {
      vi.stubEnv('AUTH_PRIVATE_KEY', 'test-hmac-secret');
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      vi.useRealTimers();
    });

    it('round-trips the DID through sign/verify', () => {
      expect(verifyState(signState(OWNER)).did).toBe(OWNER);
    });

    it('reports no returnTo when none was signed in', () => {
      expect(verifyState(signState(OWNER)).returnTo).toBeUndefined();
    });

    it('round-trips a returnTo path (#1529)', () => {
      const verified = verifyState(signState(OWNER, returnToPath));
      expect(verified.did).toBe(OWNER);
      expect(verified.returnTo).toBe(returnToPath);
    });

    it('rejects a state whose returnTo was swapped for an off-origin URL (#1529)', () => {
      const [payloadB64, sig] = signState(OWNER, returnToPath).split('.');
      const original = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
      const forged = Buffer.from(
        JSON.stringify({ ...original, returnTo: 'https://evil.com' }),
      ).toString('base64url');
      expect(() => verifyState(`${forged}.${sig}`)).toThrow(/signature mismatch/);
    });

    it('rejects a tampered payload (reused signature)', () => {
      const [, sig] = signState(OWNER).split('.');
      const forged = Buffer.from(
        JSON.stringify({ did: 'did:imajin:mallory', nonce: 'x', iat: Date.now() }),
      ).toString('base64url');
      expect(() => verifyState(`${forged}.${sig}`)).toThrow(/signature mismatch/);
    });

    it('rejects a malformed state', () => {
      expect(() => verifyState('nope')).toThrow(/malformed/);
    });

    it('rejects an expired state', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-10T00:00:00Z'));
      const state = signState(OWNER);
      vi.setSystemTime(new Date('2026-07-10T00:20:00Z')); // +20 min > 10 min TTL
      expect(() => verifyState(state)).toThrow(/expired/);
    });
  });
}
