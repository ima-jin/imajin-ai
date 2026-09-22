/**
 * Corpus identity bootstrap (#2243): the deprecated CORPUS_DID/
 * CORPUS_DID_PRIVATE_KEY override, the new CORPUS_VAULT_* fetch-at-boot
 * path, and the pre-existing "neither configured" soft-fail — mirrors
 * kernel-trust.test.ts's approach (mock global fetch, real module state).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => mocks.log,
}));

const ORIGINAL_ENV = {
  CORPUS_DID: process.env.CORPUS_DID,
  CORPUS_DID_PRIVATE_KEY: process.env.CORPUS_DID_PRIVATE_KEY,
  CORPUS_VAULT_GRANT_ID: process.env.CORPUS_VAULT_GRANT_ID,
  CORPUS_VAULT_BOOTSTRAP_DID: process.env.CORPUS_VAULT_BOOTSTRAP_DID,
  CORPUS_VAULT_BOOTSTRAP_PRIVATE_KEY: process.env.CORPUS_VAULT_BOOTSTRAP_PRIVATE_KEY,
  AUTH_SERVICE_URL: process.env.AUTH_SERVICE_URL,
};

function restoreEnv(): void {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function clearEnv(): void {
  delete process.env.CORPUS_DID;
  delete process.env.CORPUS_DID_PRIVATE_KEY;
  delete process.env.CORPUS_VAULT_GRANT_ID;
  delete process.env.CORPUS_VAULT_BOOTSTRAP_DID;
  delete process.env.CORPUS_VAULT_BOOTSTRAP_PRIVATE_KEY;
}

const BOOTSTRAP_DID = 'did:imajin:corpus-bootstrap00';
const BOOTSTRAP_PRIVATE_KEY = 'b'.repeat(64);
const MINTED_DID = 'did:imajin:corpus-signing0000';
const MINTED_PRIVATE_KEY = 'cafebabe'.repeat(8);
const BEARER_TOKEN = 'imajin_tok_corpus-test';
const GRANT_ID = 'vdg_corpus_test';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** Ack calls (#2257) made against a fake-kernel `fetch` mock, in call order. */
function ackCalls(fetchMock: ReturnType<typeof vi.fn>): [string, RequestInit][] {
  return fetchMock.mock.calls.filter((call: unknown[]) => (call[0] as string).includes('/ack')) as [string, RequestInit][];
}

/** Fakes the kernel's challenge/authenticate/fetch/ack quartet for a successful vault fetch. */
function fakeKernelFetch() {
  return vi.fn(async (url: string) => {
    if (url.endsWith('/api/challenge')) return jsonResponse({ challengeId: 'ch_1', challenge: 'raw' });
    if (url.endsWith('/api/authenticate')) return jsonResponse({ token: BEARER_TOKEN });
    if (url.includes('/fetch')) {
      return jsonResponse({ ok: true, field: `vault-minted-key:${MINTED_DID}`, value: MINTED_PRIVATE_KEY, purpose: 'corpus.boot.signing-key', oneTime: true });
    }
    if (url.includes('/ack')) return jsonResponse({ ok: true, grantId: GRANT_ID, outcome: 'used', ackedAt: new Date().toISOString() });
    throw new Error(`unexpected fetch to ${url}`);
  });
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  clearEnv();
  process.env.AUTH_SERVICE_URL = 'https://kernel.test';
});

afterEach(() => {
  vi.unstubAllGlobals();
  restoreEnv();
});

describe('deprecated CORPUS_DID/CORPUS_DID_PRIVATE_KEY override (#2243)', () => {
  it('is used verbatim, warns once, and never calls the vault fetch dance', async () => {
    process.env.CORPUS_DID = 'did:imajin:legacy0000000000000';
    process.env.CORPUS_DID_PRIVATE_KEY = 'c'.repeat(64);
    const { bootstrapCorpusIdentity, loadCorpusIdentity, _resetCorpusIdentityStateForTests } = await import('../corpus-identity');
    _resetCorpusIdentityStateForTests();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await bootstrapCorpusIdentity();
    const identity1 = loadCorpusIdentity();
    const identity2 = loadCorpusIdentity();

    expect(identity1).toEqual({ did: 'did:imajin:legacy0000000000000', privateKey: 'c'.repeat(64) });
    expect(identity2).toEqual(identity1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.log.warn).toHaveBeenCalledTimes(1);
    expect(mocks.log.warn.mock.calls[0][1]).toMatch(/DEPRECATED/);
  });

  it('takes precedence even when CORPUS_VAULT_* is also set', async () => {
    process.env.CORPUS_DID = 'did:imajin:legacy0000000000000';
    process.env.CORPUS_DID_PRIVATE_KEY = 'c'.repeat(64);
    process.env.CORPUS_VAULT_GRANT_ID = GRANT_ID;
    process.env.CORPUS_VAULT_BOOTSTRAP_DID = BOOTSTRAP_DID;
    process.env.CORPUS_VAULT_BOOTSTRAP_PRIVATE_KEY = BOOTSTRAP_PRIVATE_KEY;
    const { bootstrapCorpusIdentity, loadCorpusIdentity, _resetCorpusIdentityStateForTests } = await import('../corpus-identity');
    _resetCorpusIdentityStateForTests();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await bootstrapCorpusIdentity();

    expect(loadCorpusIdentity()?.did).toBe('did:imajin:legacy0000000000000');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('vault fetch-at-boot path (#2243)', () => {
  it('fetches the signing keypair from the vault and caches it for loadCorpusIdentity(), without acking the fetch (#2257)', async () => {
    process.env.CORPUS_VAULT_GRANT_ID = GRANT_ID;
    process.env.CORPUS_VAULT_BOOTSTRAP_DID = BOOTSTRAP_DID;
    process.env.CORPUS_VAULT_BOOTSTRAP_PRIVATE_KEY = BOOTSTRAP_PRIVATE_KEY;
    const { bootstrapCorpusIdentity, loadCorpusIdentity, _resetCorpusIdentityStateForTests } = await import('../corpus-identity');
    _resetCorpusIdentityStateForTests();
    const fetchMock = fakeKernelFetch();
    vi.stubGlobal('fetch', fetchMock);

    await bootstrapCorpusIdentity();

    expect(loadCorpusIdentity()).toEqual({ did: MINTED_DID, privateKey: MINTED_PRIVATE_KEY });
    expect(mocks.log.info).toHaveBeenCalled();
    expect(ackCalls(fetchMock)).toHaveLength(0);
  });

  it('never logs the bootstrap private key, the fetched signing key, or the bearer token', async () => {
    process.env.CORPUS_VAULT_GRANT_ID = GRANT_ID;
    process.env.CORPUS_VAULT_BOOTSTRAP_DID = BOOTSTRAP_DID;
    process.env.CORPUS_VAULT_BOOTSTRAP_PRIVATE_KEY = BOOTSTRAP_PRIVATE_KEY;
    const { bootstrapCorpusIdentity, _resetCorpusIdentityStateForTests } = await import('../corpus-identity');
    _resetCorpusIdentityStateForTests();
    vi.stubGlobal('fetch', fakeKernelFetch());

    await bootstrapCorpusIdentity();

    const logged = JSON.stringify([...mocks.log.info.mock.calls, ...mocks.log.warn.mock.calls, ...mocks.log.error.mock.calls, ...mocks.log.debug.mock.calls]);
    expect(logged).not.toContain(BOOTSTRAP_PRIVATE_KEY);
    expect(logged).not.toContain(MINTED_PRIVATE_KEY);
    expect(logged).not.toContain(BEARER_TOKEN);
  });

  it('a vault fetch failure (e.g. network error) soft-fails: no identity, warning logged, boot does not throw', async () => {
    process.env.CORPUS_VAULT_GRANT_ID = GRANT_ID;
    process.env.CORPUS_VAULT_BOOTSTRAP_DID = BOOTSTRAP_DID;
    process.env.CORPUS_VAULT_BOOTSTRAP_PRIVATE_KEY = BOOTSTRAP_PRIVATE_KEY;
    const { bootstrapCorpusIdentity, loadCorpusIdentity, _resetCorpusIdentityStateForTests } = await import('../corpus-identity');
    _resetCorpusIdentityStateForTests();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));

    await expect(bootstrapCorpusIdentity()).resolves.toBeUndefined();

    expect(loadCorpusIdentity()).toBeNull();
    expect(mocks.log.warn).toHaveBeenCalled();
  });

  it('a degraded vault fetch (grant already consumed) soft-fails: no identity, no throw, no ack (nothing was fetched)', async () => {
    process.env.CORPUS_VAULT_GRANT_ID = GRANT_ID;
    process.env.CORPUS_VAULT_BOOTSTRAP_DID = BOOTSTRAP_DID;
    process.env.CORPUS_VAULT_BOOTSTRAP_PRIVATE_KEY = BOOTSTRAP_PRIVATE_KEY;
    const { bootstrapCorpusIdentity, loadCorpusIdentity, _resetCorpusIdentityStateForTests } = await import('../corpus-identity');
    _resetCorpusIdentityStateForTests();
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/api/challenge')) return jsonResponse({ challengeId: 'ch_1', challenge: 'raw' });
      if (url.endsWith('/api/authenticate')) return jsonResponse({ token: BEARER_TOKEN });
      if (url.includes('/fetch')) return jsonResponse({ error: 'This one-time grant has already been fetched' }, 410);
      throw new Error(`unexpected fetch to ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await bootstrapCorpusIdentity();

    expect(loadCorpusIdentity()).toBeNull();
    expect(ackCalls(fetchMock)).toHaveLength(0);
  });
});

describe('grant ack semantics (#2257: one deferred ack, no fetch-time ack)', () => {
  it('markCorpusIdentityUsedForSigning() sends exactly one "used" ack, on first call only', async () => {
    process.env.CORPUS_VAULT_GRANT_ID = GRANT_ID;
    process.env.CORPUS_VAULT_BOOTSTRAP_DID = BOOTSTRAP_DID;
    process.env.CORPUS_VAULT_BOOTSTRAP_PRIVATE_KEY = BOOTSTRAP_PRIVATE_KEY;
    const { bootstrapCorpusIdentity, markCorpusIdentityUsedForSigning, _resetCorpusIdentityStateForTests } = await import('../corpus-identity');
    _resetCorpusIdentityStateForTests();
    const fetchMock = fakeKernelFetch();
    vi.stubGlobal('fetch', fetchMock);

    await bootstrapCorpusIdentity();
    expect(ackCalls(fetchMock)).toHaveLength(0);

    markCorpusIdentityUsedForSigning();
    await vi.waitFor(() => expect(ackCalls(fetchMock)).toHaveLength(1));
    const [, firstInit] = ackCalls(fetchMock)[0]!;
    expect(JSON.parse(firstInit.body as string)).toMatchObject({ outcome: 'used' });

    // A second "first sign" call (e.g. a later ingest batch) must not ack again.
    markCorpusIdentityUsedForSigning();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(ackCalls(fetchMock)).toHaveLength(1);
  });

  it('markCorpusIdentityUsedForSigning() is a no-op when there is no vault-sourced identity', async () => {
    const { bootstrapCorpusIdentity, markCorpusIdentityUsedForSigning, _resetCorpusIdentityStateForTests } = await import('../corpus-identity');
    _resetCorpusIdentityStateForTests();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await bootstrapCorpusIdentity();
    expect(() => markCorpusIdentityUsedForSigning()).not.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a fetched value that is not a usable minted keypair sends a "failed" ack (boot failure attributable to the key), not "used"', async () => {
    process.env.CORPUS_VAULT_GRANT_ID = GRANT_ID;
    process.env.CORPUS_VAULT_BOOTSTRAP_DID = BOOTSTRAP_DID;
    process.env.CORPUS_VAULT_BOOTSTRAP_PRIVATE_KEY = BOOTSTRAP_PRIVATE_KEY;
    const { bootstrapCorpusIdentity, loadCorpusIdentity, _resetCorpusIdentityStateForTests } = await import('../corpus-identity');
    _resetCorpusIdentityStateForTests();
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/api/challenge')) return jsonResponse({ challengeId: 'ch_1', challenge: 'raw' });
      if (url.endsWith('/api/authenticate')) return jsonResponse({ token: BEARER_TOKEN });
      if (url.includes('/fetch')) {
        // Fetch succeeds (a grant WAS consumed) but the field isn't a #2242 minted keypair.
        return jsonResponse({ ok: true, field: 'some-other-field', value: MINTED_PRIVATE_KEY, oneTime: true });
      }
      if (url.includes('/ack')) return jsonResponse({ ok: true, grantId: GRANT_ID, outcome: 'failed', ackedAt: new Date().toISOString() });
      throw new Error(`unexpected fetch to ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await bootstrapCorpusIdentity();

    expect(loadCorpusIdentity()).toBeNull();
    await vi.waitFor(() => expect(ackCalls(fetchMock)).toHaveLength(1));
    const [, init] = ackCalls(fetchMock)[0]!;
    expect(JSON.parse(init.body as string)).toMatchObject({ outcome: 'failed' });
  });
});

describe('neither path configured (#2243 no-op, pre-existing behavior)', () => {
  it('warns once (not per call) and returns null', async () => {
    const { bootstrapCorpusIdentity, loadCorpusIdentity, _resetCorpusIdentityStateForTests } = await import('../corpus-identity');
    _resetCorpusIdentityStateForTests();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await bootstrapCorpusIdentity();
    expect(loadCorpusIdentity()).toBeNull();
    expect(loadCorpusIdentity()).toBeNull();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.log.warn).toHaveBeenCalledTimes(1);
  });

  it('bootstrapCorpusIdentity() is a no-op when only some CORPUS_VAULT_* vars are set', async () => {
    process.env.CORPUS_VAULT_GRANT_ID = GRANT_ID;
    // CORPUS_VAULT_BOOTSTRAP_DID / _PRIVATE_KEY deliberately left unset.
    const { bootstrapCorpusIdentity, loadCorpusIdentity, _resetCorpusIdentityStateForTests } = await import('../corpus-identity');
    _resetCorpusIdentityStateForTests();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await bootstrapCorpusIdentity();

    expect(loadCorpusIdentity()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
