import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { signState, verifyState } from '../oauth-state';
import { describeOAuthStateContract } from '../../kernel/__tests__/oauth-state-contract';

// google/oauth-state.ts is a one-line createOAuthStateHelpers('google_state')
// wrapper (#2144) — see the shared contract for the sign/verify/tamper/expiry
// cases every connector's wrapper shares.
describeOAuthStateContract('google', { signState, verifyState }, '/auth/connectors/google');

// Behaviour specific to *this* wrapper (i.e. that it is actually scoped to
// 'google_state' and not accidentally sharing state with another connector) —
// not covered by the generic contract above, so it stays here (SonarCloud
// typescript:S2187).
describe('google oauth-state — wrapper-specific behaviour', () => {
  const ORIGINAL_KEY = process.env.AUTH_PRIVATE_KEY;

  beforeEach(() => {
    process.env.AUTH_PRIVATE_KEY = 'test-google-signing-secret';
  });

  afterEach(() => {
    process.env.AUTH_PRIVATE_KEY = ORIGINAL_KEY;
  });

  it('scopes thrown errors under the google_state prefix', () => {
    expect(() => verifyState('not-a-real-token')).toThrow(/^google_state: malformed token/);
  });

  it('rejects a state tampered to claim a different owner DID', () => {
    const state = signState('did:imajin:jin');
    const [bodyB64, sig] = state.split('.');
    const original = JSON.parse(Buffer.from(bodyB64, 'base64url').toString('utf8'));
    const forged = Buffer.from(
      JSON.stringify({ ...original, did: 'did:imajin:mallory' }),
    ).toString('base64url');
    expect(() => verifyState(`${forged}.${sig}`)).toThrow(/google_state: signature mismatch/);
  });

  it('mints a fresh nonce per call so two states for the same owner never collide', () => {
    const first = signState('did:imajin:jin');
    const second = signState('did:imajin:jin');
    expect(first).not.toBe(second);
  });
});
