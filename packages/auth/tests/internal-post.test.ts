/**
 * `postInternal()` (#2058, #2353): the shared service-to-service POST. Since
 * #2353 the Bearer key is the vault-sourced value resolved at boot — never
 * `process.env` — and the transport fails CLOSED without it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  markUsed: vi.fn(),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => mocks.log,
}));

vi.mock('../src/internal-api-key', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/internal-api-key')>()),
  markInternalApiKeyUsed: mocks.markUsed,
}));

import { postInternal } from '../src/internal-post';
import {
  _resetInternalApiKeyStateForTests,
  bootstrapInternalApiKey,
  InternalApiKeyUnavailableError,
  setInternalApiKeyResolver,
} from '../src/internal-api-key';

const AUTH_SERVICE_URL = 'https://auth.kernel.test';
const RESOLVED_KEY = 'resolved-vault-key';

beforeEach(() => {
  vi.clearAllMocks();
  _resetInternalApiKeyStateForTests();
  process.env.AUTH_SERVICE_URL = AUTH_SERVICE_URL;
  delete process.env.AUTH_INTERNAL_API_KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
  _resetInternalApiKeyStateForTests();
  delete process.env.AUTH_SERVICE_URL;
  delete process.env.ATTESTATION_INTERNAL_API_KEY;
});

describe('postInternal — key comes from the vault-sourced holder', () => {
  it('sends the resolved key as a Bearer token and acks first use on a 2xx', async () => {
    setInternalApiKeyResolver(() => RESOLVED_KEY);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await postInternal('/api/x', { a: 1 });

    expect(outcome).toEqual({ ok: true, status: 200, data: { ok: 1 } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${AUTH_SERVICE_URL}/api/x`);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${RESOLVED_KEY}`);
    expect(mocks.markUsed).toHaveBeenCalledTimes(1);
  });

  it('does not ack first use when the kernel rejects the call', async () => {
    setInternalApiKeyResolver(() => RESOLVED_KEY);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })));

    const outcome = await postInternal('/api/x', {});

    expect(outcome?.ok).toBe(false);
    expect(mocks.markUsed).not.toHaveBeenCalled();
  });

  it('ignores a hand-set process.env.ATTESTATION_INTERNAL_API_KEY entirely', async () => {
    process.env.ATTESTATION_INTERNAL_API_KEY = 'hand-set-env-key';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(postInternal('/api/x', {})).rejects.toBeInstanceOf(InternalApiKeyUnavailableError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('postInternal — fails closed without a resolved key', () => {
  it('throws a clear error naming the purpose and the operator grant command, and never calls fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const failure = postInternal('/api/x', {});

    await expect(failure).rejects.toBeInstanceOf(InternalApiKeyUnavailableError);
    await expect(failure).rejects.toThrow(/kernel\.attestation-internal-api-key/);
    await expect(failure).rejects.toThrow(/scripts\/grant-attestation-internal-api-key\.ts <service-did>/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never sends an empty Authorization header when the resolved value is empty', async () => {
    setInternalApiKeyResolver(() => '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(postInternal('/api/x', {})).rejects.toBeInstanceOf(InternalApiKeyUnavailableError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('after a failed boot fetch, the error names the service and its DID', async () => {
    process.env.LEARN_VAULT_BOOTSTRAP_DID = 'did:imajin:learn-bootstrap00';
    process.env.LEARN_VAULT_BOOTSTRAP_PRIVATE_KEY = 'b'.repeat(64);
    const fetchMock = vi.fn(async () => { throw new Error('vault down'); });
    vi.stubGlobal('fetch', fetchMock);
    await bootstrapInternalApiKey('learn');
    fetchMock.mockClear();

    await expect(postInternal('/api/x', {})).rejects.toThrow(
      /learn could not resolve[\s\S]*scripts\/grant-attestation-internal-api-key\.ts did:imajin:learn-bootstrap00/,
    );
    expect(fetchMock).not.toHaveBeenCalled();

    delete process.env.LEARN_VAULT_BOOTSTRAP_DID;
    delete process.env.LEARN_VAULT_BOOTSTRAP_PRIVATE_KEY;
  });

  it('still returns null (not configured, not a failure) when AUTH_SERVICE_URL is unset', async () => {
    delete process.env.AUTH_SERVICE_URL;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(postInternal('/api/x', {})).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
