/**
 * Tests for `requireAppAuth`'s bearer path, focused on the `notAppToken`
 * discriminator introduced for #1812.
 *
 * `resolveEffectiveDid` needs to tell apart two very different reasons the
 * bearer path can fail:
 *   - the bearer simply isn't an app token (bad signature/shape or expired)
 *     -> the caller should try session auth instead, since session JWTs are
 *     also sent as `Authorization: Bearer`.
 *   - the bearer IS an app token but is missing the required scope, or the
 *     auth service is unavailable -> the caller should surface that error
 *     as-is, never silently falling back to session auth.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
}));

import { requireAppAuth } from '../src/require-app-auth';
import { setVaultInternalApiKey } from './support/internal-post-test-env';

const AUTH_SERVICE_URL = 'https://auth.kernel.test/auth';

function bearerRequest(token = 'some-bearer-token'): Request {
  return new Request('https://kernel.test/connections/api/connections', {
    headers: { authorization: `Bearer ${token}` },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AUTH_SERVICE_URL = AUTH_SERVICE_URL;
});

describe('requireAppAuth — bearer path notAppToken discrimination (#1812)', () => {
  it('marks a 401 (invalid/expired token) response as notAppToken', async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'Invalid or expired app token' }), { status: 401 }),
    ) as unknown as typeof fetch;

    const result = await requireAppAuth(bearerRequest(), { scope: 'connections:read' });

    expect(result).toEqual({ error: 'Invalid or expired app token', status: 401, notAppToken: true });
  });

  it('does not mark a 403 (valid app token, missing scope) response as notAppToken', async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "Scope 'connections:read' was not granted" }), { status: 403 }),
    ) as unknown as typeof fetch;

    const result = await requireAppAuth(bearerRequest(), { scope: 'connections:read' });

    expect(result).toEqual({ error: "Scope 'connections:read' was not granted", status: 403, notAppToken: false });
  });

  it('does not mark an auth-service outage (503) as notAppToken', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    const result = await requireAppAuth(bearerRequest(), { scope: 'connections:read' });

    expect(result).toEqual({ error: 'Auth service unavailable', status: 503 });
  });

  it('resolves the app auth context on a successful verify', async () => {
    const appAuth = { appDid: 'did:imajin:app', userDid: 'did:imajin:user', scopes: ['connections:read'], attestationId: 'att_1' };
    global.fetch = vi.fn(async () => new Response(JSON.stringify(appAuth), { status: 200 })) as unknown as typeof fetch;

    const result = await requireAppAuth(bearerRequest(), { scope: 'connections:read' });

    expect(result).toEqual({ appAuth });
  });
});

describe('requireAppAuth — legacy X-App-* path vault key (#2353 step 4)', () => {
  function legacyRequest(): Request {
    return new Request('https://kernel.test/x/api/y', {
      headers: { 'x-app-did': 'did:imajin:app', 'x-app-authorization': 'att_1' },
    });
  }

  it('fails closed (503) when the vault key is missing, even if ATTESTATION_INTERNAL_API_KEY is hand-set', async () => {
    setVaultInternalApiKey(undefined);
    process.env.ATTESTATION_INTERNAL_API_KEY = 'env-value-must-be-ignored';
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    try {
      const result = await requireAppAuth(legacyRequest(), { scope: 'connections:read' });

      expect(result).toEqual({ error: 'Auth service misconfigured', status: 503 });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      delete process.env.ATTESTATION_INTERNAL_API_KEY;
    }
  });

  it('authenticates /api/apps/validate with the vault-sourced key', async () => {
    setVaultInternalApiKey('vault-sourced-key');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'nope' }), { status: 403 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    try {
      await requireAppAuth(legacyRequest(), { scope: 'connections:read' });

      const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer vault-sourced-key');
    } finally {
      setVaultInternalApiKey(undefined);
    }
  });
});
