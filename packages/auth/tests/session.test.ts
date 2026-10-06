/**
 * Tests for `getSession` — covers the dynamic `import("next/headers.js")`
 * path (#2485) by mocking `next/headers.js` with a `cookies()` stub.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SESSION_COOKIE_NAME } from '@imajin/config';

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
}));

const mocks = vi.hoisted(() => ({
  cookiesMock: vi.fn(),
  vaultKeyMock: vi.fn(),
}));

vi.mock('next/headers.js', () => ({ cookies: mocks.cookiesMock }));
vi.mock('../src/internal-post', () => ({ getVaultInternalApiKey: mocks.vaultKeyMock }));

import { getSession } from '../src/session';

const AUTH_SERVICE_URL = 'https://auth.kernel.test/auth';

function stubCookies(values: Record<string, string>) {
  mocks.cookiesMock.mockResolvedValue({
    get: (name: string) => (name in values ? { name, value: values[name] } : undefined),
  });
}

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response;
}

describe('getSession — next/headers.js dynamic import', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    process.env.AUTH_SERVICE_URL = AUTH_SERVICE_URL;
    delete process.env.ATTESTATION_INTERNAL_API_KEY;
    mocks.vaultKeyMock.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null when there is no session cookie', async () => {
    stubCookies({});
    expect(await getSession()).toBeNull();
    expect(mocks.cookiesMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolves identity from the session cookie read via cookies()', async () => {
    stubCookies({ [SESSION_COOKIE_NAME]: 'tok' });
    fetchMock.mockResolvedValue(
      jsonResponse({ did: 'did:imajin:alice', name: 'Alice', handle: 'alice', email: 'a@x.test' }),
    );

    const session = await getSession();

    expect(session).toEqual({
      id: 'did:imajin:alice',
      scope: 'actor',
      subtype: undefined,
      name: 'Alice',
      handle: 'alice',
      email: 'a@x.test',
      tier: 'soft',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `${AUTH_SERVICE_URL}/api/session`,
      expect.objectContaining({ headers: { Cookie: `${SESSION_COOKIE_NAME}=tok` } }),
    );
  });

  it('returns null when the auth service rejects the session', async () => {
    stubCookies({ [SESSION_COOKIE_NAME]: 'tok' });
    fetchMock.mockResolvedValue(jsonResponse({}, false));
    expect(await getSession()).toBeNull();
  });

  it('returns null when the session fetch throws', async () => {
    stubCookies({ [SESSION_COOKIE_NAME]: 'tok' });
    fetchMock.mockRejectedValue(new Error('boom'));
    expect(await getSession()).toBeNull();
  });

  it('attaches actingAs when the controller check passes', async () => {
    stubCookies({ [SESSION_COOKIE_NAME]: 'tok', 'x-acting-as': 'did:imajin:group' });
    mocks.vaultKeyMock.mockReturnValue('vault-key');
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ did: 'did:imajin:alice', name: 'Alice' }))
      .mockResolvedValueOnce(jsonResponse({ valid: true, role: 'admin', allowedServices: ['events'] }));

    const session = await getSession({ service: 'events' });

    expect(session?.actingAs).toBe('did:imajin:group');
    expect(session?.actingAsServices).toEqual(['events']);
  });

  it('drops actingAs when the controller is not allowed for the service', async () => {
    stubCookies({ [SESSION_COOKIE_NAME]: 'tok', 'x-acting-as': 'did:imajin:group' });
    mocks.vaultKeyMock.mockReturnValue('vault-key');
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ did: 'did:imajin:alice' }))
      .mockResolvedValueOnce(jsonResponse({ valid: true, role: 'owner', allowedServices: ['events'] }));

    const session = await getSession({ service: 'chat' });

    expect(session?.id).toBe('did:imajin:alice');
    expect(session?.actingAs).toBeUndefined();
  });

  it('drops actingAs without reading process.env when the vault key is missing, even if ATTESTATION_INTERNAL_API_KEY is hand-set (#2353 step 4)', async () => {
    process.env.ATTESTATION_INTERNAL_API_KEY = 'env-value-must-be-ignored';
    stubCookies({ [SESSION_COOKIE_NAME]: 'tok', 'x-acting-as': 'did:imajin:group' });
    fetchMock.mockResolvedValueOnce(jsonResponse({ did: 'did:imajin:alice' }));

    const session = await getSession();

    expect(session?.actingAs).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    delete process.env.ATTESTATION_INTERNAL_API_KEY;
  });

  it('drops actingAs when no internal API key is configured', async () => {
    stubCookies({ [SESSION_COOKIE_NAME]: 'tok', 'x-acting-as': 'did:imajin:group' });
    fetchMock.mockResolvedValueOnce(jsonResponse({ did: 'did:imajin:alice' }));

    const session = await getSession();

    expect(session?.actingAs).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
