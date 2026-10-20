import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { CookieJar } from 'tough-cookie';
import {
  clearCookieOptions, createSessionToken, sessionCookieName, sessionCookieOptions,
  type SessionConfig,
} from '../src/session';
import { createCallbackHandler, createLogoutHandler, createSessionHandler } from '../src/handlers';
import { getSession } from '../src/get-session';

const { readCookie } = vi.hoisted(() => ({ readCookie: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: vi.fn(async () => ({ get: readCookie })) }));

const origin = 'https://kernel.example';
const baseConfig = { authUrl: origin, secret: 'test-only-session-secret-not-for-production' };
const config = { ...baseConfig, appDid: 'did:imajin:coffee' };
const user = { did: 'did:imajin:alice', displayName: 'Alice', handle: 'alice', attestationId: 'att_123' };

beforeEach(() => {
  readCookie.mockReset();
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => Response.json(user)));
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('app cookie names', () => {
  it('derives a stable cookie-safe name from the full app DID', () => {
    // Independent known SHA-256 vector: UTF-8 "abc".
    expect(sessionCookieName({ ...baseConfig, appDid: 'abc' })).toBe(
      'imajin_app_session_ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sessionCookieName(config)).toBe(sessionCookieName({ ...config }));
    expect(sessionCookieName(config)).not.toBe('imajin_session');
    expect(sessionCookieName({ ...config, secret: 'rotated', maxAge: 30 })).toBe(sessionCookieName(config));
  });

  it('keeps all six first-party app identities and slug-like collisions distinct', () => {
    const identities = ['events', 'coffee', 'learn', 'market', 'dykil', 'links', 'a:b', 'a-b', 'A-B', 'é'];
    const names = identities.map((id) => sessionCookieName({ ...config, appDid: `did:imajin:${id}` }));
    expect(new Set(names).size).toBe(identities.length);
    for (const name of names) expect(name).toMatch(/^imajin_app_session_[\da-f]{64}$/);
  });

  it('honors an explicit safe override even without an app DID', () => {
    expect(sessionCookieName({ ...baseConfig, cookieName: 'coffee_session' })).toBe('coffee_session');
  });

  it.each([undefined, '', '  '])('refuses a missing app identity (%s)', (appDid) => {
    expect(() => sessionCookieName({ ...baseConfig, appDid })).toThrow('appDid is required');
  });

  it.each(['', ' imajin_session', 'imajin_session ', 'x; imajin_session', 'x=y', 'x\n'])(
    'refuses invalid cookie names: %j', (cookieName) => {
      expect(() => sessionCookieName({ ...config, cookieName })).toThrow('valid nonempty cookie name');
    },
  );

  it('rejects the kernel override in both writers and all handler factories', async () => {
    const reserved = { ...config, cookieName: 'imajin_session' };
    expect(() => sessionCookieName(reserved)).toThrow('reserved for the kernel');
    expect(() => sessionCookieOptions('token', reserved)).toThrow('reserved for the kernel');
    expect(() => clearCookieOptions(reserved)).toThrow('reserved for the kernel');
    for (const factory of [createCallbackHandler, createLogoutHandler, createSessionHandler]) {
      expect(() => factory(reserved)).toThrow('reserved for the kernel');
      expect(() => factory(baseConfig)).toThrow('appDid is required');
    }
    await expect(getSession(reserved)).rejects.toThrow('reserved for the kernel');
    expect(readCookie).not.toHaveBeenCalled();
  });

  it.each([config, { ...baseConfig, cookieName: 'coffee_session' }])(
    'uses the same host-only name and attributes for set and clear', (sessionConfig) => {
      const written = sessionCookieOptions('token', { ...sessionConfig, secureCookies: true, maxAge: 123 });
      const cleared = clearCookieOptions({ ...sessionConfig, secureCookies: true });
      expect(written).toEqual({
        name: sessionCookieName(sessionConfig), value: 'token', httpOnly: true,
        secure: true, sameSite: 'lax', maxAge: 123, path: '/',
      });
      expect(cleared).toEqual({ ...written, value: '', maxAge: 0 });
      expect(written).not.toHaveProperty('domain');
      expect(written.name).not.toBe('imajin_session');
    },
  );
});

describe('session readers', () => {
  it.each([config, { ...baseConfig, cookieName: 'coffee_session' }])(
    'reads only the app cookie in both server and session route APIs', async (sessionConfig) => {
      const token = await createSessionToken(user, sessionConfig);
      readCookie.mockImplementation((name: string) => name === sessionCookieName(sessionConfig) ? { value: token } : undefined);
      expect(await getSession(sessionConfig)).toEqual(user);
      expect(await (await createSessionHandler(sessionConfig)()).json()).toEqual(user);
      expect(readCookie.mock.calls).toEqual([[sessionCookieName(sessionConfig)], [sessionCookieName(sessionConfig)]]);
    },
  );

  it('does not fall back to a legacy/kernel cookie even when signed with the same secret', async () => {
    const token = await createSessionToken(user, config);
    readCookie.mockImplementation((name: string) => name === 'imajin_session' ? { value: token } : undefined);
    expect(await getSession(config)).toBeNull();
    expect(await (await createSessionHandler(config)()).json()).toBeNull();
    expect(readCookie).not.toHaveBeenCalledWith('imajin_session');
  });

  it('rejects invalid app session tokens in both readers', async () => {
    readCookie.mockReturnValue({ value: 'not-a-jwt' });
    expect(await getSession(config)).toBeNull();
    expect(await (await createSessionHandler(config)()).json()).toBeNull();
  });
});

describe('same-host callback and logout isolation', () => {
  it('preserves the kernel and sibling app cookies across every app login and logout', async () => {
    const jar = new CookieJar();
    jar.setCookieSync('imajin_session=kernel-session; Path=/; Secure; HttpOnly; SameSite=Lax', origin);
    const apps = ['events', 'coffee', 'learn', 'market', 'dykil', 'links'].map((app) => ({
      ...baseConfig, appDid: `did:imajin:${app}`, publicUrl: `${origin}/${app}`,
    }));

    function applyResponse(response: Response, sessionConfig: SessionConfig) {
      const header = response.headers.get('set-cookie');
      expect(header).toBeTruthy();
      const cookie = jar.setCookieSync(header!, origin);
      expect(cookie.key).toBe(sessionCookieName(sessionConfig));
      expect(cookie.key).not.toBe('imajin_session');
    }

    for (const app of apps) {
      const before = jar.getCookieStringSync(origin);
      const request = new NextRequest(`${app.publicUrl}/api/auth/callback?attestation_id=att_123&user_did=${user.did}`);
      applyResponse(await createCallbackHandler(app)(request), app);
      for (const cookie of before.split('; ')) expect(jar.getCookieStringSync(origin)).toContain(cookie);
    }
    expect(jar.getCookiesSync(origin)).toHaveLength(7);

    for (const app of apps) {
      applyResponse(await createLogoutHandler(app)(new NextRequest(app.publicUrl)), app);
      expect(jar.getCookiesSync(origin).some((cookie) => cookie.key === sessionCookieName(app))).toBe(false);
      expect(jar.getCookiesSync(origin).find((cookie) => cookie.key === 'imajin_session')?.value).toBe('kernel-session');
    }
    expect(jar.getCookieStringSync(origin)).toBe('imajin_session=kernel-session');
  });

  it('never emits a kernel-cookie write with a safe explicit override', async () => {
    const custom = { ...baseConfig, cookieName: 'custom_app_session' };
    const request = new NextRequest(`${origin}/api/auth/callback?attestation_id=att_123&user_did=${user.did}`);
    for (const response of [
      await createCallbackHandler(custom)(request),
      await createLogoutHandler(custom)(request),
    ]) {
      expect(response.cookies.getAll().map((cookie) => cookie.name)).toEqual(['custom_app_session']);
      expect(response.cookies.get('imajin_session')).toBeUndefined();
    }
  });
});
