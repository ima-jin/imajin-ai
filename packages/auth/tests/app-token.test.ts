/**
 * Tests for `verifyAppToken` (#1069 Phase 1) — the thin wrapper apps call to
 * verify a session-scoped app token against the kernel's stateless verify
 * endpoint.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
}));

import { verifyAppToken } from '../src/app-token';

const AUTH_SERVICE_URL = 'https://auth.kernel.test/auth';

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AUTH_SERVICE_URL = AUTH_SERVICE_URL;
});

describe('verifyAppToken — success (#1069 Phase 1)', () => {
  it('resolves sub/aud/scopes on a 200 response', async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ sub: 'did:imajin:user', aud: 'coffee', scopes: ['profile:read'] }), {
        status: 200,
      })
    ) as unknown as typeof fetch;

    const result = await verifyAppToken('some-token', { aud: 'coffee' });

    expect(result).toEqual({ sub: 'did:imajin:user', aud: 'coffee', scopes: ['profile:read'] });
  });

  it('posts the token and aud to the kernel verify endpoint', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ sub: 'did:imajin:user', aud: 'coffee', scopes: [] }), { status: 200 })
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await verifyAppToken('some-token', { aud: 'coffee' });

    expect(fetchMock).toHaveBeenCalledWith(
      `${AUTH_SERVICE_URL}/api/tokens/app/verify`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ token: 'some-token', aud: 'coffee' }),
      })
    );
  });
});

describe('verifyAppToken — failure modes (#1069 Phase 1)', () => {
  it('returns null on a non-2xx response (e.g. audience mismatch, expired)', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'nope' }), { status: 401 })) as unknown as typeof fetch;

    const result = await verifyAppToken('some-token', { aud: 'coffee' });

    expect(result).toBeNull();
  });

  it('returns null when the auth service is unreachable', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    const result = await verifyAppToken('some-token', { aud: 'coffee' });

    expect(result).toBeNull();
  });

  it('returns null when AUTH_SERVICE_URL is not configured', async () => {
    delete process.env.AUTH_SERVICE_URL;
    global.fetch = vi.fn() as unknown as typeof fetch;

    const result = await verifyAppToken('some-token', { aud: 'coffee' });

    expect(result).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it.each(['dev-jin.imajin.ai', 'jin.imajin.ai', 'https://jin.imajin.ai'])(
    'refuses a host audience %s without calling the kernel (#2706)',
    async (host) => {
      const fetchMock = vi.fn();
      global.fetch = fetchMock as unknown as typeof fetch;

      const result = await verifyAppToken('some-token', { aud: host });

      expect(result).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

describe('verifyAppToken — act-as claim (#2639 / #2644)', () => {
  it('surfaces actingAs when the kernel verify response carries it', async () => {
    global.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ sub: 'did:imajin:user', aud: 'market', scopes: [], actingAs: 'did:imajin:group' }),
        { status: 200 }
      )
    ) as unknown as typeof fetch;

    const result = await verifyAppToken('some-token', { aud: 'market' });

    expect(result).toEqual({
      sub: 'did:imajin:user',
      aud: 'market',
      scopes: [],
      actingAs: 'did:imajin:group',
    });
  });

  it.each([[''], [null], [42], [{ did: 'x' }]])('omits actingAs for a non-string or empty claim (%j)', async (bad) => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ sub: 'did:imajin:user', aud: 'market', scopes: [], actingAs: bad }), {
        status: 200,
      })
    ) as unknown as typeof fetch;

    const result = await verifyAppToken('some-token', { aud: 'market' });

    expect(result).toEqual({ sub: 'did:imajin:user', aud: 'market', scopes: [] });
  });
});
