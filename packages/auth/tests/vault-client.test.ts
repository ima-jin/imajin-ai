/**
 * `loadFromVault` (#2243): unit tests over the challenge/authenticate/
 * fetch/ack HTTP dance, without a real kernel — every call is a stubbed
 * `fetch` matched by URL suffix.
 *
 * Coverage:
 *  - happy path: authenticates, fetches, derives the minted-key DID from
 *    the field name, and acks 'used' with the purpose as the ack note.
 *  - `onMissing: 'degrade'` — a failed fetch is swallowed into `degraded`.
 *  - `onMissing: 'fail'` — a failed fetch throws, and the thrown message
 *    never contains the grant id's fetched value or the bearer token.
 *  - ack failures (non-2xx or thrown) never fail `loadFromVault()` itself.
 *  - redaction: no logged call, anywhere, contains the fetched secret,
 *    the bootstrap private key, or the bearer token.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => mocks.log,
}));

const AUTH_SERVICE_URL = 'https://auth.kernel.test';
const BOOTSTRAP_DID = 'did:imajin:bootstrap0000000';
const BOOTSTRAP_PRIVATE_KEY = 'a'.repeat(64);
const BEARER_TOKEN = 'imajin_tok_test-bearer-token';
const SECRET_PRIVATE_KEY = 'deadbeef'.repeat(8); // the value being fetched from the vault
const MINTED_DID = 'did:imajin:minted00000000000';
const GRANT_ID = 'vdg_test123';

function urlEndsWith(url: string, suffix: string): boolean {
  return url.endsWith(suffix);
}

interface FakeKernelOptions {
  fetchStatus?: number;
  fetchBody?: Record<string, unknown>;
  ackStatus?: number;
  ackThrows?: boolean;
}

/** Builds a fetch mock simulating challenge -> authenticate -> fetch -> ack. */
function fakeKernelFetch(options: FakeKernelOptions = {}) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (urlEndsWith(url, '/api/challenge')) {
      return new Response(JSON.stringify({ challengeId: 'ch_1', challenge: 'raw-challenge-bytes' }), { status: 200 });
    }
    if (urlEndsWith(url, '/api/authenticate')) {
      return new Response(JSON.stringify({ token: BEARER_TOKEN }), { status: 200 });
    }
    if (url.includes('/fetch')) {
      const status = options.fetchStatus ?? 200;
      const body = options.fetchBody ?? {
        ok: true,
        field: `vault-minted-key:${MINTED_DID}`,
        value: SECRET_PRIVATE_KEY,
        purpose: 'corpus.boot',
        oneTime: true,
      };
      return new Response(JSON.stringify(body), { status });
    }
    if (url.includes('/ack')) {
      if (options.ackThrows) {
        throw new TypeError('network error');
      }
      const status = options.ackStatus ?? 200;
      return new Response(JSON.stringify({ ok: status < 400, grantId: GRANT_ID, outcome: 'used', ackedAt: new Date().toISOString() }), { status });
    }
    throw new Error(`unexpected fetch to ${url} (init: ${JSON.stringify(init)})`);
  });
}

function allLoggedText(): string {
  const allCalls = [...mocks.log.warn.mock.calls, ...mocks.log.error.mock.calls, ...mocks.log.info.mock.calls];
  return JSON.stringify(allCalls);
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadFromVault happy path', () => {
  it('authenticates, fetches the key, derives the minted DID, and acks used with the purpose', async () => {
    const { loadFromVault } = await import('../src/vault-client');
    const fetchMock = fakeKernelFetch();
    vi.stubGlobal('fetch', fetchMock);

    const result = await loadFromVault({
      grant: GRANT_ID,
      purpose: 'corpus.boot.signing-key',
      keys: [{ key: 'CORPUS_DID_PRIVATE_KEY', onMissing: 'fail' }],
      identity: { did: BOOTSTRAP_DID, privateKey: BOOTSTRAP_PRIVATE_KEY },
      authServiceUrl: AUTH_SERVICE_URL,
    });

    expect(result.values.CORPUS_DID_PRIVATE_KEY).toBe(SECRET_PRIVATE_KEY);
    expect(result.dids.CORPUS_DID_PRIVATE_KEY).toBe(MINTED_DID);
    expect(result.degraded).toEqual([]);

    const ackCall = fetchMock.mock.calls.find(([url]: [string]) => url.includes('/ack'));
    expect(ackCall).toBeDefined();
    const ackBody = JSON.parse((ackCall![1] as RequestInit).body as string);
    expect(ackBody).toMatchObject({ outcome: 'used', note: 'corpus.boot.signing-key' });
    expect((ackCall![1] as RequestInit).headers).toMatchObject({ Authorization: `Bearer ${BEARER_TOKEN}` });
  });

  it('authenticates by signing the returned challenge string with the bootstrap private key', async () => {
    const { loadFromVault } = await import('../src/vault-client');
    const fetchMock = fakeKernelFetch();
    vi.stubGlobal('fetch', fetchMock);

    await loadFromVault({
      grant: GRANT_ID,
      purpose: 'test',
      keys: [{ key: 'K', onMissing: 'degrade' }],
      identity: { did: BOOTSTRAP_DID, privateKey: BOOTSTRAP_PRIVATE_KEY },
      authServiceUrl: AUTH_SERVICE_URL,
    });

    const authCall = fetchMock.mock.calls.find(([url]: [string]) => url.endsWith('/api/authenticate'));
    const authBody = JSON.parse((authCall![1] as RequestInit).body as string);
    expect(authBody.id).toBe(BOOTSTRAP_DID);
    expect(authBody.challengeId).toBe('ch_1');
    expect(typeof authBody.signature).toBe('string');
    expect(authBody.signature.length).toBe(128); // 64-byte Ed25519 sig, hex-encoded
  });
});

describe('onMissing semantics', () => {
  it('degrade: a failed fetch is omitted from values/dids and listed in degraded, without throwing', async () => {
    const { loadFromVault } = await import('../src/vault-client');
    const fetchMock = fakeKernelFetch({ fetchStatus: 410, fetchBody: { error: 'This one-time grant has already been fetched' } });
    vi.stubGlobal('fetch', fetchMock);

    const result = await loadFromVault({
      grant: GRANT_ID,
      purpose: 'corpus.boot',
      keys: [{ key: 'CORPUS_DID_PRIVATE_KEY', onMissing: 'degrade' }],
      identity: { did: BOOTSTRAP_DID, privateKey: BOOTSTRAP_PRIVATE_KEY },
      authServiceUrl: AUTH_SERVICE_URL,
    });

    expect(result.values.CORPUS_DID_PRIVATE_KEY).toBeUndefined();
    expect(result.dids.CORPUS_DID_PRIVATE_KEY).toBeUndefined();
    expect(result.degraded).toEqual(['CORPUS_DID_PRIVATE_KEY']);
    // No ack call — nothing was fetched, so #2235's ack precondition never held.
    expect(fetchMock.mock.calls.some(([url]: [string]) => url.includes('/ack'))).toBe(false);
  });

  it('fail: a failed fetch throws, and the thrown message never leaks the token or a fetched value', async () => {
    const { loadFromVault } = await import('../src/vault-client');
    const fetchMock = fakeKernelFetch({ fetchStatus: 403, fetchBody: { error: 'This grant is no longer active' } });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      loadFromVault({
        grant: GRANT_ID,
        purpose: 'corpus.boot',
        keys: [{ key: 'CORPUS_DID_PRIVATE_KEY', onMissing: 'fail' }],
        identity: { did: BOOTSTRAP_DID, privateKey: BOOTSTRAP_PRIVATE_KEY },
        authServiceUrl: AUTH_SERVICE_URL,
      }),
    ).rejects.toThrow(/CORPUS_DID_PRIVATE_KEY/);

    const thrown = await loadFromVault({
      grant: GRANT_ID,
      purpose: 'corpus.boot',
      keys: [{ key: 'CORPUS_DID_PRIVATE_KEY', onMissing: 'fail' }],
      identity: { did: BOOTSTRAP_DID, privateKey: BOOTSTRAP_PRIVATE_KEY },
      authServiceUrl: AUTH_SERVICE_URL,
    }).catch((err: Error) => err);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).not.toContain(BEARER_TOKEN);
    expect((thrown as Error).message).not.toContain(BOOTSTRAP_PRIVATE_KEY);
    expect((thrown as Error).message).not.toContain(SECRET_PRIVATE_KEY);
  });
});

describe('ack is best-effort', () => {
  it('a non-2xx ack response does not fail loadFromVault, only logs a warning', async () => {
    const { loadFromVault } = await import('../src/vault-client');
    const fetchMock = fakeKernelFetch({ ackStatus: 409 });
    vi.stubGlobal('fetch', fetchMock);

    const result = await loadFromVault({
      grant: GRANT_ID,
      purpose: 'corpus.boot',
      keys: [{ key: 'CORPUS_DID_PRIVATE_KEY', onMissing: 'fail' }],
      identity: { did: BOOTSTRAP_DID, privateKey: BOOTSTRAP_PRIVATE_KEY },
      authServiceUrl: AUTH_SERVICE_URL,
    });

    expect(result.values.CORPUS_DID_PRIVATE_KEY).toBe(SECRET_PRIVATE_KEY);
    expect(mocks.log.warn).toHaveBeenCalled();
  });

  it('a thrown ack request (network error) does not fail loadFromVault, only logs a warning', async () => {
    const { loadFromVault } = await import('../src/vault-client');
    const fetchMock = fakeKernelFetch({ ackThrows: true });
    vi.stubGlobal('fetch', fetchMock);

    const result = await loadFromVault({
      grant: GRANT_ID,
      purpose: 'corpus.boot',
      keys: [{ key: 'CORPUS_DID_PRIVATE_KEY', onMissing: 'fail' }],
      identity: { did: BOOTSTRAP_DID, privateKey: BOOTSTRAP_PRIVATE_KEY },
      authServiceUrl: AUTH_SERVICE_URL,
    });

    expect(result.values.CORPUS_DID_PRIVATE_KEY).toBe(SECRET_PRIVATE_KEY);
    expect(mocks.log.warn).toHaveBeenCalled();
  });
});

describe('redaction (#2243)', () => {
  it('never logs the fetched secret, the bootstrap private key, or the bearer token, across a full run', async () => {
    const { loadFromVault } = await import('../src/vault-client');
    const fetchMock = fakeKernelFetch({ ackStatus: 500 }); // exercise the ack-warning log path too
    vi.stubGlobal('fetch', fetchMock);

    await loadFromVault({
      grant: GRANT_ID,
      purpose: 'corpus.boot',
      keys: [{ key: 'CORPUS_DID_PRIVATE_KEY', onMissing: 'fail' }],
      identity: { did: BOOTSTRAP_DID, privateKey: BOOTSTRAP_PRIVATE_KEY },
      authServiceUrl: AUTH_SERVICE_URL,
    });

    const logged = allLoggedText();
    expect(logged).not.toContain(SECRET_PRIVATE_KEY);
    expect(logged).not.toContain(BOOTSTRAP_PRIVATE_KEY);
    expect(logged).not.toContain(BEARER_TOKEN);
  });

  it('never logs the fetched secret even on a degrade path', async () => {
    const { loadFromVault } = await import('../src/vault-client');
    const fetchMock = fakeKernelFetch({ fetchStatus: 404, fetchBody: { error: 'No delegation grant found for this id' } });
    vi.stubGlobal('fetch', fetchMock);

    await loadFromVault({
      grant: GRANT_ID,
      purpose: 'corpus.boot',
      keys: [{ key: 'CORPUS_DID_PRIVATE_KEY', onMissing: 'degrade' }],
      identity: { did: BOOTSTRAP_DID, privateKey: BOOTSTRAP_PRIVATE_KEY },
      authServiceUrl: AUTH_SERVICE_URL,
    });

    const logged = allLoggedText();
    expect(logged).not.toContain(BOOTSTRAP_PRIVATE_KEY);
    expect(logged).not.toContain(BEARER_TOKEN);
  });
});

describe('configuration errors', () => {
  it('throws when AUTH_SERVICE_URL is neither passed nor set in env', async () => {
    delete process.env.AUTH_SERVICE_URL;
    const { loadFromVault } = await import('../src/vault-client');

    await expect(
      loadFromVault({
        grant: GRANT_ID,
        purpose: 'corpus.boot',
        keys: [{ key: 'K', onMissing: 'fail' }],
        identity: { did: BOOTSTRAP_DID, privateKey: BOOTSTRAP_PRIVATE_KEY },
      }),
    ).rejects.toThrow(/AUTH_SERVICE_URL/);
  });

  it('propagates an authentication failure regardless of any key onMissing setting', async () => {
    const { loadFromVault } = await import('../src/vault-client');
    const fetchMock = vi.fn(async (url: string) => {
      if (urlEndsWith(url, '/api/challenge')) {
        return new Response(JSON.stringify({ challengeId: 'ch_1', challenge: 'raw' }), { status: 200 });
      }
      if (urlEndsWith(url, '/api/authenticate')) {
        return new Response(JSON.stringify({ error: 'Invalid signature' }), { status: 401 });
      }
      throw new Error(`unexpected fetch to ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      loadFromVault({
        grant: GRANT_ID,
        purpose: 'corpus.boot',
        keys: [{ key: 'K', onMissing: 'degrade' }],
        identity: { did: BOOTSTRAP_DID, privateKey: BOOTSTRAP_PRIVATE_KEY },
        authServiceUrl: AUTH_SERVICE_URL,
      }),
    ).rejects.toThrow(/authentication failed/);
  });
});
