/**
 * `emitAttestation()` (#1820, #2037):
 * - verifies `pending` and `originUrl` are threaded into the POST body sent
 *   to the internal attestations route. Both are optional and, when
 *   omitted, simply aren't present on the body (the internal route defaults
 *   `pendingSignature` to false server-side).
 * - verifies the internal API key resolution (#2037): `ATTESTATION_INTERNAL_API_KEY`
 *   is canonical and matches what the kernel's routes actually check;
 *   `AUTH_INTERNAL_API_KEY` is accepted as a deprecated one-release
 *   fallback, warning once. A rejected (non-2xx) forward is logged at warn
 *   with status + route, never the key, and increments the exported
 *   forward-failure counter.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { _resetInternalApiKeyStateForTests, setInternalApiKeyResolver } from '../src/internal-api-key';

const mocks = vi.hoisted(() => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => mocks.log,
}));

const AUTH_SERVICE_URL = 'https://auth.kernel.test';
const ATTESTATION_KEY = 'attestation-internal-key';
const LEGACY_KEY = 'legacy-auth-internal-key';

function baseParams(overrides: Record<string, unknown> = {}) {
  return {
    issuer_did: 'did:imajin:supplier',
    subject_did: 'did:imajin:recipient',
    type: 'supply.received',
    context_id: 'lot_1',
    context_type: 'supply',
    ...overrides,
  };
}

function internalRouteBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = fetchMock.mock.calls.find(([url]: [string]) => url.endsWith('/api/attestations/internal'));
  return JSON.parse(call![1].body as string) as Record<string, unknown>;
}

/** Simulates the kernel's real check: only `expectedKey` authenticates, everything else is 401. */
function fakeKernelFetch(expectedKey: string): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string, init: RequestInit) => {
    const auth = (init.headers as Record<string, string>).Authorization;
    if (auth !== `Bearer ${expectedKey}`) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    }
    if (url.endsWith('/api/attestations/internal')) {
      return new Response(JSON.stringify({ issuedAt: 'now' }), { status: 201 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  // Vault-sourced (#2353): the key is injected via the resolver, never read from process.env.
  _resetInternalApiKeyStateForTests();
  delete process.env.AUTH_INTERNAL_API_KEY;
  process.env.AUTH_SERVICE_URL = AUTH_SERVICE_URL;
});

afterEach(() => {
  delete process.env.AUTH_SERVICE_URL;
  _resetInternalApiKeyStateForTests();
  delete process.env.AUTH_INTERNAL_API_KEY;
  vi.unstubAllGlobals();
});

describe('emitAttestation pending/originUrl threading (#1820)', () => {
  beforeEach(() => {
    setInternalApiKeyResolver(() => ATTESTATION_KEY);
  });

  it('includes pending: true in the internal route request body when passed', async () => {
    const { emitAttestation } = await import('../src/emit-attestation');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ issuedAt: 'now' }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    await emitAttestation(baseParams({ pending: true }));

    expect(internalRouteBody(fetchMock).pending).toBe(true);
  });

  it('includes originUrl in the internal route request body when passed', async () => {
    const { emitAttestation } = await import('../src/emit-attestation');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ issuedAt: 'now' }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    await emitAttestation(baseParams({ originUrl: 'https://xprize.example.com' }));

    expect(internalRouteBody(fetchMock).originUrl).toBe('https://xprize.example.com');
  });

  it('omits pending and originUrl from the body when the caller does not supply them', async () => {
    const { emitAttestation } = await import('../src/emit-attestation');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ issuedAt: 'now' }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    await emitAttestation(baseParams());

    const body = internalRouteBody(fetchMock);
    expect(body.pending).toBeUndefined();
    expect(body.originUrl).toBeUndefined();
  });
});

describe('internal API key resolution (#2037)', () => {
  it('authenticates with the resolved (vault-sourced) internal API key and the route accepts the forward', async () => {
    setInternalApiKeyResolver(() => ATTESTATION_KEY);
    const { emitAttestation, getAttestationForwardFailureCount } = await import('../src/emit-attestation');
    const fetchMock = fakeKernelFetch(ATTESTATION_KEY);
    vi.stubGlobal('fetch', fetchMock);

    await emitAttestation(baseParams());

    expect(internalRouteBody(fetchMock).issuer_did).toBe('did:imajin:supplier');
    expect(getAttestationForwardFailureCount()).toBe(0);
    expect(mocks.log.warn).not.toHaveBeenCalled();
  });

  it('falls back to AUTH_INTERNAL_API_KEY and still authenticates when no vault-sourced key was resolved, warning once per process', async () => {
    process.env.AUTH_INTERNAL_API_KEY = LEGACY_KEY;
    const { emitAttestation, getAttestationForwardFailureCount } = await import('../src/emit-attestation');
    const fetchMock = fakeKernelFetch(LEGACY_KEY);
    vi.stubGlobal('fetch', fetchMock);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await emitAttestation(baseParams());
    await emitAttestation(baseParams());

    expect(internalRouteBody(fetchMock).issuer_did).toBe('did:imajin:supplier');
    expect(getAttestationForwardFailureCount()).toBe(0);
    // Once per process, not once per call.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/AUTH_INTERNAL_API_KEY is deprecated/);
    warnSpy.mockRestore();
  });

  it('rejects, logs a warn (status + route, never the key), and increments the failure counter on a mismatched key', async () => {
    setInternalApiKeyResolver(() => 'client-key');
    const { emitAttestation, getAttestationForwardFailureCount } = await import('../src/emit-attestation');
    const fetchMock = fakeKernelFetch('server-key'); // the route's own key differs from what the client sends
    vi.stubGlobal('fetch', fetchMock);

    await emitAttestation(baseParams());

    expect(getAttestationForwardFailureCount()).toBe(1);
    expect(mocks.log.warn).toHaveBeenCalledTimes(1);
    const [meta] = mocks.log.warn.mock.calls[0];
    expect(meta).toMatchObject({ status: 401, route: '/api/attestations/internal' });
    expect(JSON.stringify(meta)).not.toContain('client-key');
    expect(JSON.stringify(meta)).not.toContain('server-key');
  });

  it('fails closed when no key was resolved — never calls fetch, logs the operator grant command, and never sends an empty header', async () => {
    const { emitAttestation } = await import('../src/emit-attestation');
    const fetchMock = fakeKernelFetch(ATTESTATION_KEY);
    vi.stubGlobal('fetch', fetchMock);

    const result = await emitAttestation(baseParams());

    expect(result).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.log.error).toHaveBeenCalledTimes(1);
    const [meta] = mocks.log.error.mock.calls[0];
    expect(meta.err).toContain('scripts/grant-attestation-internal-api-key.ts');
    expect(meta.err).toContain('kernel.attestation-internal-api-key');
  });
});
