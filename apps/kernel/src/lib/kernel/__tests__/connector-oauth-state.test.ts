import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// ─── connector-oauth-state.ts — signed state payload (#1333, appDid #1704) ───
//
// The callback arrives sessionless, so `state` is the only channel that can
// carry the app DID whose sealed config owns the OAuth client credentials
// (#1704) across the provider redirect. These tests pin:
//   1. Backward compatibility — signing/verifying without an appDid keeps
//      returning the same DID + optional returnTo fields as before #1704.
//   2. The new appDid round-trips through sign → verify.
//   3. A tampered appDid fails verification like any other tampered field.

import { createOAuthStateHelpers } from '../connector-oauth-state';

const ORIGINAL_KEY = process.env.AUTH_PRIVATE_KEY;

beforeEach(() => {
  process.env.AUTH_PRIVATE_KEY = 'test-signing-secret';
});

afterEach(() => {
  process.env.AUTH_PRIVATE_KEY = ORIGINAL_KEY;
});

describe('createOAuthStateHelpers — backward compatibility', () => {
  const { signState, verifyState } = createOAuthStateHelpers('test_state');

  it('round-trips did with no returnTo and no appDid', () => {
    const state = signState('did:imajin:owner');
    expect(verifyState(state)).toEqual({ did: 'did:imajin:owner', returnTo: undefined, appDid: undefined });
  });

  it('round-trips did + returnTo with no appDid', () => {
    const state = signState('did:imajin:owner', '/auth/connectors/github');
    expect(verifyState(state)).toEqual({
      did: 'did:imajin:owner',
      returnTo: '/auth/connectors/github',
      appDid: undefined,
    });
  });
});

describe('createOAuthStateHelpers — appDid (#1704)', () => {
  const { signState, verifyState } = createOAuthStateHelpers('test_state');

  it('round-trips did + appDid with no returnTo', () => {
    const state = signState('did:imajin:owner', undefined, 'did:imajin:agrifortress');
    expect(verifyState(state)).toEqual({
      did: 'did:imajin:owner',
      returnTo: undefined,
      appDid: 'did:imajin:agrifortress',
    });
  });

  it('round-trips did + returnTo + appDid together', () => {
    const state = signState('did:imajin:owner', '/auth/connectors/quickbooks', 'did:imajin:agrifortress');
    expect(verifyState(state)).toEqual({
      did: 'did:imajin:owner',
      returnTo: '/auth/connectors/quickbooks',
      appDid: 'did:imajin:agrifortress',
    });
  });

  it('fails verification when the appDid is tampered with', () => {
    const state = signState('did:imajin:owner', undefined, 'did:imajin:agrifortress');
    const [bodyB64, sig] = state.split('.');
    const tamperedBody = JSON.parse(Buffer.from(bodyB64, 'base64url').toString('utf8'));
    tamperedBody.appDid = 'did:imajin:malicious';
    const tampered = `${Buffer.from(JSON.stringify(tamperedBody)).toString('base64url')}.${sig}`;

    expect(() => verifyState(tampered)).toThrow(/signature mismatch/);
  });
});
