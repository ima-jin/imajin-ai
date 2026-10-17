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
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';

// The import-time test below loads vault/index.ts, which pulls in the DB and bus
// singletons. Stub them so the test exercises module evaluation only.

vi.mock('@/src/db', () => ({
  db: {},
  vaultDelegationGrants: {},
  vaultGrantRequests: {},
  channelLinks: {},
}));

vi.mock('@/src/lib/kernel/id', () => ({ generateId: (p: string) => `${p}_test` }));

vi.mock('@imajin/bus', () => ({ publish: vi.fn().mockResolvedValue(undefined) }));

import {
  getSealKey,
  getNodeSigningIdentity,
  getNodeXPublicKey,
  getOwnerXPublicKey,
  _resetSealingCache,
} from '../sealing.js';

beforeEach(() => {
  _resetSealingCache();
  vi.stubEnv('AUTH_PRIVATE_KEY', undefined);
});

afterEach(() => {
  _resetSealingCache();
  vi.unstubAllEnvs();
});

describe('vault key derivation in production', () => {
  const derivations: Array<[string, () => unknown]> = [
    ['getSealKey', getSealKey],
    ['getNodeSigningIdentity', getNodeSigningIdentity],
    ['getNodeXPublicKey', getNodeXPublicKey],
    ['getOwnerXPublicKey', getOwnerXPublicKey],
  ];

  it.each(derivations)('%s throws when AUTH_PRIVATE_KEY is absent', (_name, derive) => {
    vi.stubEnv('NODE_ENV', 'production');
    _resetSealingCache();

    expect(() => derive()).toThrow(/AUTH_PRIVATE_KEY is required in production/);
  });

  it.each(derivations)('%s succeeds when AUTH_PRIVATE_KEY is present', (_name, derive) => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('AUTH_PRIVATE_KEY', randomBytes(32).toString('hex'));
    _resetSealingCache();

    expect(() => derive()).not.toThrow();
  });

  it('derives the dev fallback outside production so local dev keeps working', () => {
    vi.stubEnv('NODE_ENV', 'development');
    _resetSealingCache();

    const identity = getNodeSigningIdentity();
    expect(identity.senderDid).toBe(`did:imajin:${identity.senderPubkey.slice(0, 16)}`);
  });

  it('names the standalone-server env pitfall in the error message', () => {
    vi.stubEnv('NODE_ENV', 'production');
    _resetSealingCache();

    // The error is the only breadcrumb an operator gets at 3am, so it must point
    // at the actual cause: `node server.js` does not read .env.local.
    expect(() => getSealKey()).toThrow(/does NOT load \.env\.local/);
  });
});

describe('module import in production', () => {
  let vaultImport: Promise<typeof import('../index.js')>;

  // Evaluate the cold graph under the actual build-time guard conditions,
  // after mocks, not inside a 5s assertion window (#2848). A failed setup
  // blocks this suite instead of letting tests re-enter an unfinished import.
  beforeAll(async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('AUTH_PRIVATE_KEY', undefined);
    vi.stubEnv('VAULT_PATH', undefined);
    try {
      vaultImport = import('../index.js');
      await vaultImport;
    } finally {
      vi.unstubAllEnvs();
    }
  }, 30_000);

  it('does not derive keys merely by importing the vault', async () => {
    // `next build` imports route modules with NODE_ENV=production on a machine
    // that legitimately has no AUTH_PRIVATE_KEY. Deriving a key at module scope
    // therefore converts the runtime guard into a build failure, which is
    // exactly what happened when the identity was logged at init.
    vi.stubEnv('NODE_ENV', 'production');

    await expect(vaultImport).resolves.toBeDefined();
  });
});

describe('JWT signing key in production', () => {
  it('refuses to mint tokens with an ephemeral keypair', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { createSessionToken } = await import('@/src/lib/auth/jwt');

    // An ephemeral key would invalidate every session on restart and cannot be
    // verified by any other process, so this must fail rather than fall back.
    await expect(
      createSessionToken({ sub: 'did:imajin:test', scope: 'actor' }),
    ).rejects.toThrow(/AUTH_PRIVATE_KEY is required in production/);
  });
});
