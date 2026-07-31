/**
 * Production key guardrails (#1520).
 *
 * Incident: prod-jin restarted without AUTH_PRIVATE_KEY in its process env.
 * Every key derivation silently fell back to a deterministic dev seed, giving
 * the node a different signing identity than the one that sealed all existing
 * entries — so every vault read failed SIGNATURE_INVALID platform-wide with no
 * error at boot.
 *
 * The fallback is a development convenience. In production its absence must be
 * a hard failure, and these tests pin that in both directions: throw in
 * production, still work in development.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  getSealKey,
  getNodeSigningIdentity,
  getNodeXPublicKey,
  getOwnerXPublicKey,
  _resetSealingCache,
} from '../sealing.js';

const originalNodeEnv = process.env.NODE_ENV;

/**
 * NODE_ENV is readonly in Next's type surface, so assign through a cast rather
 * than fighting the ambient declaration.
 */
function setNodeEnv(value: string | undefined): void {
  if (value === undefined) {
    delete (process.env as Record<string, string | undefined>).NODE_ENV;
    return;
  }
  (process.env as Record<string, string | undefined>).NODE_ENV = value;
}

beforeEach(() => {
  _resetSealingCache();
  delete process.env.AUTH_PRIVATE_KEY;
});

afterEach(() => {
  _resetSealingCache();
  delete process.env.AUTH_PRIVATE_KEY;
  setNodeEnv(originalNodeEnv);
});

describe('vault key derivation in production', () => {
  const derivations: Array<[string, () => unknown]> = [
    ['getSealKey', getSealKey],
    ['getNodeSigningIdentity', getNodeSigningIdentity],
    ['getNodeXPublicKey', getNodeXPublicKey],
    ['getOwnerXPublicKey', getOwnerXPublicKey],
  ];

  it.each(derivations)('%s throws when AUTH_PRIVATE_KEY is absent', (_name, derive) => {
    setNodeEnv('production');
    _resetSealingCache();

    expect(() => derive()).toThrow(/AUTH_PRIVATE_KEY is required in production/);
  });

  it.each(derivations)('%s succeeds when AUTH_PRIVATE_KEY is present', (_name, derive) => {
    setNodeEnv('production');
    process.env.AUTH_PRIVATE_KEY = randomBytes(32).toString('hex');
    _resetSealingCache();

    expect(() => derive()).not.toThrow();
  });

  it('derives the dev fallback outside production so local dev keeps working', () => {
    setNodeEnv('development');
    _resetSealingCache();

    const identity = getNodeSigningIdentity();
    expect(identity.senderDid).toBe(`did:imajin:${identity.senderPubkey.slice(0, 16)}`);
  });

  it('names the standalone-server env pitfall in the error message', () => {
    setNodeEnv('production');
    _resetSealingCache();

    // The error is the only breadcrumb an operator gets at 3am, so it must point
    // at the actual cause: `node server.js` does not read .env.local.
    expect(() => getSealKey()).toThrow(/does NOT load \.env\.local/);
  });
});

describe('JWT signing key in production', () => {
  it('refuses to mint tokens with an ephemeral keypair', async () => {
    setNodeEnv('production');
    const { createSessionToken } = await import('@/src/lib/auth/jwt');

    // An ephemeral key would invalidate every session on restart and cannot be
    // verified by any other process, so this must fail rather than fall back.
    await expect(
      createSessionToken({ sub: 'did:imajin:test', scope: 'actor' }),
    ).rejects.toThrow(/AUTH_PRIVATE_KEY is required in production/);
  });
});
