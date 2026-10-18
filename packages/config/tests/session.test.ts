import { describe, it, expect, afterEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { getSessionCookieName, getSessionCookieOptions } from '../src/session';

afterEach(() => vi.unstubAllEnvs());

describe('host-only session default (#1069 phase 2)', () => {
  it.each(['', 'host', 'typo'])('fails narrow for scope %j in each deployed environment', (scope) => {
    vi.stubEnv('SESSION_COOKIE_SCOPE', scope);
    for (const [env, host] of [['prod', 'jin.imajin.ai'], ['dev', 'dev-jin.imajin.ai']] as const) {
      vi.stubEnv('NEXT_PUBLIC_SERVICE_PREFIX', `https://${host}/`);
      const { name, options } = getSessionCookieOptions(env);
      expect(options).not.toHaveProperty('domain');
      const response = new NextResponse();
      response.cookies.set(name, 'FAKE_SESSION', options);
      const header = response.headers.get('set-cookie')!;
      expect(header).not.toMatch(/domain=/i);
      expect(header).toContain('HttpOnly');
      expect(header).toContain('Secure');
      expect(header).toContain('SameSite=none');
      expect(header).toContain('Path=/');
      expect(header).toContain('Max-Age=86400');
    }
  });

  it('restores the legacy options and serialized cookie byte-for-byte with domain rollback', () => {
    vi.stubEnv('NEXT_PUBLIC_SERVICE_PREFIX', 'https://jin.imajin.ai/');
    vi.stubEnv('SESSION_COOKIE_SCOPE', 'domain');
    const config = getSessionCookieOptions('prod');
    const legacyOptions = {
      httpOnly: true, secure: true, sameSite: 'none' as const,
      path: '/', domain: '.imajin.ai', maxAge: 86400,
    };
    expect(config).toEqual({ name: 'imajin_session', options: legacyOptions });
    vi.useFakeTimers();
    try {
      const actual = new NextResponse();
      const legacy = new NextResponse();
      actual.cookies.set(config.name, 'FAKE_SESSION', config.options);
      legacy.cookies.set('imajin_session', 'FAKE_SESSION', legacyOptions);
      expect(actual.headers.get('set-cookie')).toBe(legacy.headers.get('set-cookie'));
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['', 'host', 'domain'])('preserves localhost attributes with scope %j', (scope) => {
    vi.stubEnv('NEXT_PUBLIC_SERVICE_PREFIX', 'http://localhost:3000/');
    vi.stubEnv('SESSION_COOKIE_SCOPE', scope);
    expect(getSessionCookieOptions('dev')).toEqual({
      name: 'imajin_session_dev',
      options: { httpOnly: true, secure: false, sameSite: 'lax', path: '/', maxAge: 86400 },
    });
  });

  it('keeps dev/prod cookie names and environment auto-detection', () => {
    vi.stubEnv('IMAJIN_ENV', 'dev');
    expect(getSessionCookieOptions().name).toBe('imajin_session_dev');
    vi.stubEnv('IMAJIN_ENV', 'prod');
    vi.stubEnv('NODE_ENV', 'production');
    expect(getSessionCookieName()).toBe('imajin_session');
    vi.stubEnv('NODE_ENV', 'development');
    expect(getSessionCookieName()).toBe('imajin_session_dev');
  });
});
