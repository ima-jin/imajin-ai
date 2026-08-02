import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { signState, verifyState } from '../oauth-state';

const OWNER = 'did:imajin:eric';

beforeEach(() => {
  vi.stubEnv('AUTH_PRIVATE_KEY', 'test-hmac-secret');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('github oauth-state (#1333)', () => {
  it('round-trips the DID through sign/verify', () => {
    expect(verifyState(signState(OWNER)).did).toBe(OWNER);
  });

  it('reports no returnTo when none was signed in', () => {
    expect(verifyState(signState(OWNER)).returnTo).toBeUndefined();
  });

  it('round-trips a returnTo path (#1529)', () => {
    const verified = verifyState(signState(OWNER, '/auth/connectors/github'));
    expect(verified.did).toBe(OWNER);
    expect(verified.returnTo).toBe('/auth/connectors/github');
  });

  it('rejects a state whose returnTo was swapped for an off-origin URL (#1529)', () => {
    const [payloadB64, sig] = signState(OWNER, '/auth/connectors/github').split('.');
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
