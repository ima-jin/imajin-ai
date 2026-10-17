import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { CookieJar } from 'tough-cookie';
import { withSessionCookie } from '../session-cookie';

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SERVICE_PREFIX', 'https://jin.imajin.ai/');
  vi.stubEnv('IMAJIN_ENV', 'prod');
  vi.stubEnv('SESSION_COOKIE_SCOPE', '');
});
afterEach(() => vi.unstubAllEnvs());

describe('session cookie scope migration', () => {
  it.each([
    ['prod', 'jin.imajin.ai', 'imajin_session', 'dev-jin.imajin.ai'],
    ['dev', 'dev-jin.imajin.ai', 'imajin_session_dev', 'jin.imajin.ai'],
  ])('migrates legacy-only and coexisting cookies without a mass logout (%s)', async (env, host, name, otherEnv) => {
    vi.stubEnv('IMAJIN_ENV', env);
    vi.stubEnv('NEXT_PUBLIC_SERVICE_PREFIX', `https://${host}/`);
    const url = `https://${host}/auth`;
    const jar = new CookieJar();
    await jar.setCookie(`${name}=FAKE_LEGACY; Domain=.imajin.ai; Path=/; HttpOnly; Secure`, url);
    expect(await jar.getCookieString(url)).toContain(`${name}=FAKE_LEGACY`);
    // Simulate a previous host-only write with a legacy cookie still present.
    await jar.setCookie(`${name}=FAKE_HOST; Path=/; HttpOnly; Secure`, url);
    expect((await jar.getCookies(url)).filter(c => c.key === name)).toHaveLength(2);

    const response = NextResponse.json({ ok: true });
    response.cookies.set('x-acting-as', 'FAKE_GROUP', { path: '/' });
    withSessionCookie(response, 'FAKE_REFRESH');
    const headers = response.headers.getSetCookie();
    expect(headers).toHaveLength(3);
    const active = headers.find(h => h.startsWith(`${name}=FAKE_REFRESH`))!;
    expect(active).not.toMatch(/domain=/i);
    expect(active).toContain('HttpOnly');
    expect(active).toContain('Secure');
    expect(active).toContain('SameSite=none');
    const legacyExpiry = headers.find(h => /domain=/i.test(h))!;
    expect(legacyExpiry).toContain('Domain=.imajin.ai');
    expect(legacyExpiry).toContain('Max-Age=0');
    for (const header of headers) await jar.setCookie(header, url);
    const sessions = (await jar.getCookies(url)).filter(c => c.key === name);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ value: 'FAKE_REFRESH', hostOnly: true, httpOnly: true, secure: true });
    for (const outside of [otherEnv, 'fixready.imajin.ai', 'karaoke.imajin.ai', 'scorecard.imajin.ai', 'preview.imajin.ai', 'imajin.ai']) {
      expect(await jar.getCookieString(`https://${outside}/`)).not.toContain(name);
    }
    // Honest phase 3 gap: same-host path apps still get the credential.
    expect(await jar.getCookieString(`https://${host}/coffee`)).toContain(`${name}=FAKE_REFRESH`);
  });

  it.each(['', 'domain'])('logout clears both cookies regardless of rollback mode %j', async (scope) => {
    vi.stubEnv('SESSION_COOKIE_SCOPE', scope);
    const jar = new CookieJar();
    const url = 'https://jin.imajin.ai/';
    await jar.setCookie('imajin_session=FAKE_LEGACY; Domain=.imajin.ai; Path=/', url);
    await jar.setCookie('imajin_session=FAKE_HOST; Path=/', url);
    const response = withSessionCookie(NextResponse.json({ ok: true }), null);
    expect(response.headers.getSetCookie()).toHaveLength(2);
    for (const header of response.headers.getSetCookie()) {
      expect(header).toContain('Max-Age=0');
      await jar.setCookie(header, url);
    }
    expect(await jar.getCookieString(url)).toBe('');
  });

  it('rollback restores the legacy cookie and removes a leftover host-only cookie', async () => {
    vi.stubEnv('SESSION_COOKIE_SCOPE', 'domain');
    const url = 'https://jin.imajin.ai/';
    const jar = new CookieJar();
    await jar.setCookie('imajin_session=FAKE_HOST; Path=/', url);
    const response = withSessionCookie(NextResponse.json({ ok: true }), 'FAKE_ROLLBACK');
    for (const header of response.headers.getSetCookie()) await jar.setCookie(header, url);
    expect(await jar.getCookies(url)).toMatchObject([{ key: 'imajin_session', value: 'FAKE_ROLLBACK', domain: 'imajin.ai', hostOnly: false }]);
  });

  it('localhost emits just the unchanged local cookie', () => {
    vi.stubEnv('NEXT_PUBLIC_SERVICE_PREFIX', 'http://localhost:3000/');
    const response = withSessionCookie(NextResponse.json({ ok: true }), 'FAKE_LOCAL');
    expect(response.headers.getSetCookie()).toHaveLength(1);
    expect(response.headers.get('set-cookie')).not.toMatch(/domain=|; Secure/i);
    expect(response.headers.get('set-cookie')).toContain('SameSite=lax');
  });
});
