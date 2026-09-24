/**
 * `ATTESTATION_INTERNAL_API_KEY` fetch-at-boot (#2245): the deprecated env
 * override, the vault fetch-at-boot path (dynamic grant discovery by
 * purpose, reusing corpus's existing CORPUS_VAULT_BOOTSTRAP_* identity),
 * and the "neither configured" soft-fail — mirrors corpus-identity.test.ts's
 * approach (mock global fetch, real module state).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => mocks.log,
}));

const ORIGINAL_ENV = {
  ATTESTATION_INTERNAL_API_KEY: process.env.ATTESTATION_INTERNAL_API_KEY,
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
  delete process.env.ATTESTATION_INTERNAL_API_KEY;
  delete process.env.CORPUS_VAULT_BOOTSTRAP_DID;
  delete process.env.CORPUS_VAULT_BOOTSTRAP_PRIVATE_KEY;
}

const BOOTSTRAP_DID = 'did:imajin:corpus-bootstrap00';
const BOOTSTRAP_PRIVATE_KEY = 'b'.repeat(64);
const VAULT_KEY_VALUE = 'deadbeef'.repeat(8);
const BEARER_TOKEN = 'imajin_tok_corpus-test';
const GRANT_ID = 'vdg_attestation_key_test';
const PURPOSE = 'kernel.attestation-internal-api-key';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function ackCalls(fetchMock: ReturnType<typeof vi.fn>): [string, RequestInit][] {
  return fetchMock.mock.calls.filter((call: unknown[]) => (call[0] as string).includes('/ack')) as [string, RequestInit][];
}

/** Fakes the kernel's challenge/authenticate/grants-list/fetch/ack quintet for a successful vault fetch. */
function fakeKernelFetch() {
  return vi.fn(async (url: string) => {
    if (url.endsWith('/api/challenge')) return jsonResponse({ challengeId: 'ch_1', challenge: 'raw' });
    if (url.endsWith('/api/authenticate')) return jsonResponse({ token: BEARER_TOKEN });
    if (url.includes('/api/vault/delegation/grants?purpose=')) {
      return jsonResponse({ grants: [{ grantId: GRANT_ID, status: 'active' }] });
    }
    if (url.includes('/fetch')) {
      return jsonResponse({ ok: true, field: `internal-secret:${PURPOSE}`, value: VAULT_KEY_VALUE });
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

describe('deprecated ATTESTATION_INTERNAL_API_KEY env override (#2245)', () => {
  it('is used verbatim, warns once, and never calls the vault fetch dance', async () => {
    process.env.ATTESTATION_INTERNAL_API_KEY = 'hand-set-legacy-key';
    const { bootstrapAttestationInternalApiKey, getAttestationInternalApiKey, _resetAttestationKeyStateForTests } = await import('../attestation-key');
    _resetAttestationKeyStateForTests();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await bootstrapAttestationInternalApiKey();

    expect(getAttestationInternalApiKey()).toBe('hand-set-legacy-key');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.log.warn).toHaveBeenCalledTimes(1);
    expect(mocks.log.warn.mock.calls[0][1]).toMatch(/DEPRECATED/);
  });

  it('takes precedence even when the CORPUS_VAULT_BOOTSTRAP_* identity is also set', async () => {
    process.env.ATTESTATION_INTERNAL_API_KEY = 'hand-set-legacy-key';
    process.env.CORPUS_VAULT_BOOTSTRAP_DID = BOOTSTRAP_DID;
    process.env.CORPUS_VAULT_BOOTSTRAP_PRIVATE_KEY = BOOTSTRAP_PRIVATE_KEY;
    const { bootstrapAttestationInternalApiKey, getAttestationInternalApiKey, _resetAttestationKeyStateForTests } = await import('../attestation-key');
    _resetAttestationKeyStateForTests();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await bootstrapAttestationInternalApiKey();

    expect(getAttestationInternalApiKey()).toBe('hand-set-legacy-key');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('vault fetch-at-boot path (#2245, dynamic grant discovery by purpose)', () => {
  it('resolves the active grant by purpose, fetches the key, and caches it without acking the fetch (#2257)', async () => {
    process.env.CORPUS_VAULT_BOOTSTRAP_DID = BOOTSTRAP_DID;
    process.env.CORPUS_VAULT_BOOTSTRAP_PRIVATE_KEY = BOOTSTRAP_PRIVATE_KEY;
    const { bootstrapAttestationInternalApiKey, getAttestationInternalApiKey, _resetAttestationKeyStateForTests } = await import('../attestation-key');
    _resetAttestationKeyStateForTests();
    const fetchMock = fakeKernelFetch();
    vi.stubGlobal('fetch', fetchMock);

    await bootstrapAttestationInternalApiKey();

    expect(getAttestationInternalApiKey()).toBe(VAULT_KEY_VALUE);
    expect(mocks.log.info).toHaveBeenCalled();
    expect(ackCalls(fetchMock)).toHaveLength(0);
    const listCall = fetchMock.mock.calls.find(([url]: [string]) => (url as string).includes('/api/vault/delegation/grants?purpose='));
    expect((listCall![0] as string)).toContain(encodeURIComponent(PURPOSE));
  });

  it('never logs the bootstrap private key, the fetched key, or the bearer token', async () => {
    process.env.CORPUS_VAULT_BOOTSTRAP_DID = BOOTSTRAP_DID;
    process.env.CORPUS_VAULT_BOOTSTRAP_PRIVATE_KEY = BOOTSTRAP_PRIVATE_KEY;
    const { bootstrapAttestationInternalApiKey, _resetAttestationKeyStateForTests } = await import('../attestation-key');
    _resetAttestationKeyStateForTests();
    vi.stubGlobal('fetch', fakeKernelFetch());

    await bootstrapAttestationInternalApiKey();

    const logged = JSON.stringify([...mocks.log.info.mock.calls, ...mocks.log.warn.mock.calls, ...mocks.log.error.mock.calls, ...mocks.log.debug.mock.calls]);
    expect(logged).not.toContain(BOOTSTRAP_PRIVATE_KEY);
    expect(logged).not.toContain(VAULT_KEY_VALUE);
    expect(logged).not.toContain(BEARER_TOKEN);
  });

  it('a vault fetch failure (e.g. network error) soft-fails: no key, warning logged, boot does not throw', async () => {
    process.env.CORPUS_VAULT_BOOTSTRAP_DID = BOOTSTRAP_DID;
    process.env.CORPUS_VAULT_BOOTSTRAP_PRIVATE_KEY = BOOTSTRAP_PRIVATE_KEY;
    const { bootstrapAttestationInternalApiKey, getAttestationInternalApiKey, _resetAttestationKeyStateForTests } = await import('../attestation-key');
    _resetAttestationKeyStateForTests();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));

    await expect(bootstrapAttestationInternalApiKey()).resolves.toBeUndefined();

    expect(getAttestationInternalApiKey()).toBeNull();
    expect(mocks.log.warn).toHaveBeenCalled();
  });

  it('degrades (no active grant yet for this purpose) soft-fails: no key, no throw, no ack', async () => {
    process.env.CORPUS_VAULT_BOOTSTRAP_DID = BOOTSTRAP_DID;
    process.env.CORPUS_VAULT_BOOTSTRAP_PRIVATE_KEY = BOOTSTRAP_PRIVATE_KEY;
    const { bootstrapAttestationInternalApiKey, getAttestationInternalApiKey, _resetAttestationKeyStateForTests } = await import('../attestation-key');
    _resetAttestationKeyStateForTests();
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/api/challenge')) return jsonResponse({ challengeId: 'ch_1', challenge: 'raw' });
      if (url.endsWith('/api/authenticate')) return jsonResponse({ token: BEARER_TOKEN });
      if (url.includes('/api/vault/delegation/grants?purpose=')) return jsonResponse({ grants: [] });
      throw new Error(`unexpected fetch to ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await bootstrapAttestationInternalApiKey();

    expect(getAttestationInternalApiKey()).toBeNull();
    expect(ackCalls(fetchMock)).toHaveLength(0);
    expect(mocks.log.warn).toHaveBeenCalled();
  });
});

describe('grant ack semantics (#2257: one deferred ack, no fetch-time ack)', () => {
  it('markAttestationKeyUsedForForwarding() sends exactly one "used" ack, on first call only', async () => {
    process.env.CORPUS_VAULT_BOOTSTRAP_DID = BOOTSTRAP_DID;
    process.env.CORPUS_VAULT_BOOTSTRAP_PRIVATE_KEY = BOOTSTRAP_PRIVATE_KEY;
    const { bootstrapAttestationInternalApiKey, markAttestationKeyUsedForForwarding, _resetAttestationKeyStateForTests } = await import('../attestation-key');
    _resetAttestationKeyStateForTests();
    const fetchMock = fakeKernelFetch();
    vi.stubGlobal('fetch', fetchMock);

    await bootstrapAttestationInternalApiKey();
    expect(ackCalls(fetchMock)).toHaveLength(0);

    markAttestationKeyUsedForForwarding();
    await vi.waitFor(() => expect(ackCalls(fetchMock)).toHaveLength(1));
    const [, firstInit] = ackCalls(fetchMock)[0]!;
    expect(JSON.parse(firstInit.body as string)).toMatchObject({ outcome: 'used' });

    markAttestationKeyUsedForForwarding();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(ackCalls(fetchMock)).toHaveLength(1);
  });

  it('markAttestationKeyUsedForForwarding() is a no-op when there is no vault-sourced key', async () => {
    const { bootstrapAttestationInternalApiKey, markAttestationKeyUsedForForwarding, _resetAttestationKeyStateForTests } = await import('../attestation-key');
    _resetAttestationKeyStateForTests();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await bootstrapAttestationInternalApiKey();
    expect(() => markAttestationKeyUsedForForwarding()).not.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('neither path configured (#2245 no-op)', () => {
  it('bootstrapAttestationInternalApiKey() is a no-op and getAttestationInternalApiKey() returns null', async () => {
    const { bootstrapAttestationInternalApiKey, getAttestationInternalApiKey, _resetAttestationKeyStateForTests } = await import('../attestation-key');
    _resetAttestationKeyStateForTests();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await bootstrapAttestationInternalApiKey();

    expect(getAttestationInternalApiKey()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is a no-op when only one of the two CORPUS_VAULT_BOOTSTRAP_* vars is set', async () => {
    process.env.CORPUS_VAULT_BOOTSTRAP_DID = BOOTSTRAP_DID;
    // CORPUS_VAULT_BOOTSTRAP_PRIVATE_KEY deliberately left unset.
    const { bootstrapAttestationInternalApiKey, getAttestationInternalApiKey, _resetAttestationKeyStateForTests } = await import('../attestation-key');
    _resetAttestationKeyStateForTests();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await bootstrapAttestationInternalApiKey();

    expect(getAttestationInternalApiKey()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
