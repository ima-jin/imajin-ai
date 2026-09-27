/**
 * Tests for `requestAppToken` (#1069 Phase 1, #2394) — the client-side
 * helper a federated app uses to mint a session-scoped app token from the
 * caller's own live kernel session.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { requestAppToken } from '../src/app-token';

const AUTH_URL = 'https://kernel.test';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('requestAppToken — success', () => {
  it('resolves the minted token/expiresIn/scopes on a 200 response', async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ token: 'session-app-token', expiresIn: 600, scopes: ['profile:read'] }), { status: 200 }),
    ) as unknown as typeof fetch;

    const result = await requestAppToken({ authUrl: AUTH_URL, aud: 'dykil.example.com' });

    expect(result).toEqual({ token: 'session-app-token', expiresIn: 600, scopes: ['profile:read'] });
  });

  it('posts to {authUrl}/auth/api/tokens/app with aud and scopes, crediting cookies', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ token: 't', expiresIn: 600, scopes: [] }), { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await requestAppToken({ authUrl: AUTH_URL, aud: 'dykil.example.com', scopes: ['profile:read'] });

    expect(fetchMock).toHaveBeenCalledWith(
      `${AUTH_URL}/auth/api/tokens/app`,
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ aud: 'dykil.example.com', scopes: ['profile:read'] }),
      }),
    );
  });

  it('defaults scopes to an empty array when omitted', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ token: 't', expiresIn: 600, scopes: [] }), { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await requestAppToken({ authUrl: AUTH_URL, aud: 'dykil.example.com' });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ body: JSON.stringify({ aud: 'dykil.example.com', scopes: [] }) }),
    );
  });
});

describe('requestAppToken — failure modes', () => {
  it('returns null on a non-2xx response (e.g. no live session, unregistered app)', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401 })) as unknown as typeof fetch;

    expect(await requestAppToken({ authUrl: AUTH_URL, aud: 'dykil.example.com' })).toBeNull();
  });

  it('returns null when the kernel is unreachable', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    expect(await requestAppToken({ authUrl: AUTH_URL, aud: 'dykil.example.com' })).toBeNull();
  });
});
