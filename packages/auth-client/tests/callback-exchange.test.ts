import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { verifyAsync } from '@noble/ed25519';
import { NextRequest } from 'next/server';
import { createCallbackHandler, createLoginHandler } from '../src/handlers';
import { sessionCookieName, verifySessionToken } from '../src/session';
import { loadAppSigningKey } from '../src/load-app-signing-key';
import { callbackQuery, code, exchangeResult, mockCallbackFetch, signingKey, state, withState } from './callback-fixture';
vi.mock('../src/load-app-signing-key', () => ({ loadAppSigningKey: vi.fn() }));

const config = {
  appDid: 'did:imajin:app', appId: 'app_unit', authUrl: 'https://kernel.test',
  publicUrl: 'https://app.test/coffee', secret: randomBytes(32).toString('hex'), secureCookies: true,
};
const cookieName = sessionCookieName(config);
const profile = { did: 'did:imajin:display-only', displayName: 'Alice', handle: 'alice', avatar: '/avatar.png' };
const request = (query = callbackQuery) =>
  withState(new NextRequest(`${config.publicUrl}/api/auth/callback${query}`), config);

beforeEach(() => {
  mockCallbackFetch(profile);
  vi.mocked(loadAppSigningKey).mockResolvedValue({ ...signingKey, appDid: config.appDid });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks(); });

function expectDenied(response: Response & { cookies: { get: (name: string) => unknown } }) {
  expect(new URL(response.headers.get('location')!).searchParams.get('auth_error')).toBe('authorization_invalid');
  expect(response.cookies.get(cookieName)).toBeUndefined();
  expect(response.cookies.get(`${cookieName}_state`)).toMatchObject({ value: '', maxAge: 0 });
  expect(response.headers.get('cache-control')).toBe('no-store');
}

describe('state-bound app sign-in', () => {
  it('creates a fresh short-lived app-only state cookie and directs login to kernel consent', async () => {
    const login = createLoginHandler({ ...config, scopes: ['profile:read'] });
    const first = await login();
    const second = await login();
    const url = new URL(first.headers.get('location')!);
    const issuedState = url.searchParams.get('state');
    expect(issuedState).toMatch(/^[a-f0-9]{64}$/);
    expect(url.origin + url.pathname).toBe(`${config.authUrl}/auth/authorize`);
    expect(url.searchParams.get('app_id')).toBe(config.appId);
    expect(url.searchParams.get('scopes')).toBe('profile:read');
    expect(first.cookies.get(`${cookieName}_state`)).toMatchObject({
      value: issuedState, httpOnly: true, sameSite: 'lax', secure: true, path: '/', maxAge: 300,
    });
    expect(first.cookies.get(`${cookieName}_state`)).not.toHaveProperty('domain');
    expect(second.cookies.get(`${cookieName}_state`)?.value).not.toBe(issuedState);
    expect(first.cookies.get(cookieName)).toBeUndefined();
  });

  it('constructs login lazily and refuses missing runtime registry identity', async () => {
    const unavailable = { ...config, get appId(): string { throw new Error('runtime unavailable'); } };
    expect(() => createLoginHandler(unavailable)).not.toThrow();
    const handler = createLoginHandler({ ...config, appId: undefined });
    await expect(handler()).rejects.toThrow('appId and appDid');
    const noDid = createLoginHandler({ ...config, appDid: '', cookieName: 'explicit' });
    await expect(noDid()).rejects.toThrow('appId and appDid');
  });

  it('exchanges a signed code and uses only the kernel subject and attestation for the session', async () => {
    const response = await createCallbackHandler(config)(request(`${callbackQuery}&user_did=did:imajin:query-only`));
    const user = await verifySessionToken(response.cookies.get(cookieName)!.value, config);
    expect(user).toEqual({
      did: exchangeResult.subjectDid, attestationId: exchangeResult.attestationId,
      displayName: profile.displayName, handle: profile.handle, avatar: `${config.authUrl}/avatar.png`,
    });
    const [url, options] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe(`${config.authUrl}/auth/api/apps/token`);
    const body = JSON.parse(options!.body as string);
    expect(body).toMatchObject({ appDid: config.appDid, code, state });
    expect(await verifyAsync(
      body.signature, new TextEncoder().encode(`${body.appDid}:${body.code}:${body.nonce}:${body.timestamp}`),
      signingKey.publicKey,
    )).toBe(true);
    expect(options).toMatchObject({ redirect: 'error', cache: 'no-store', method: 'POST' });
    expect(fetch).toHaveBeenLastCalledWith(
      `${config.authUrl}/profile/api/profile/${encodeURIComponent(exchangeResult.subjectDid)}`, expect.any(Object),
    );
    expect(response.cookies.get(`${cookieName}_state`)).toMatchObject({ maxAge: 0 });
  });

  it.each(['unissued', 'reused', 'expired', 'foreign-app', 'revoked-attestation'])(
    'never creates a session after a rejected %s exchange', async () => {
      vi.mocked(fetch).mockResolvedValue(Response.json({ error: 'authorization_invalid' }, { status: 400 }));
      expectDenied(await createCallbackHandler(config)(request()));
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it.each(['missing', 'mismatch', 'malformed', 'legacy', 'no-code', 'bad-code'])(
    'refuses %s callback validation before exchange', async (failure) => {
      const req = request();
      if (failure === 'missing') req.cookies.delete(`${cookieName}_state`);
      if (failure === 'mismatch') req.cookies.set(`${cookieName}_state`, randomBytes(32).toString('hex'));
      if (failure === 'malformed') req.nextUrl.searchParams.set('state', 'invalid');
      if (failure === 'legacy') req.nextUrl.search = '?attestation_id=att_display&user_did=did:imajin:display';
      if (failure === 'no-code') req.nextUrl.searchParams.delete('code');
      if (failure === 'bad-code') req.nextUrl.searchParams.set('code', 'invalid');
      expectDenied(await createCallbackHandler(config)(req));
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    null, {}, { ...exchangeResult, subjectDid: '' }, { ...exchangeResult, subjectDid: 1 },
    { ...exchangeResult, attestationId: '' }, { ...exchangeResult, token: '' },
  ])('refuses a malformed exchange response', async (body) => {
    vi.mocked(fetch).mockResolvedValue(Response.json(body));
    expectDenied(await createCallbackHandler(config)(request()));
  });

  it('refuses a signing identity for another app', async () => {
    vi.mocked(loadAppSigningKey).mockResolvedValue({ ...signingKey, appDid: 'did:imajin:other' });
    expectDenied(await createCallbackHandler(config)(request()));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails closed without logging network or provider diagnostics', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(fetch).mockRejectedValue(new Error('provider unavailable'));
    expectDenied(await createCallbackHandler(config)(request()));
    expect(error).not.toHaveBeenCalled();
  });
});
