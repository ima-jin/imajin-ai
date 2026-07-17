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
    expect(verifyState(signState(OWNER))).toBe(OWNER);
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
