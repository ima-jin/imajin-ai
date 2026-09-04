/**
 * Tests for getSessionCookieOptions (#1069 Phase 1).
 *
 * `SESSION_COOKIE_SCOPE=host` is the flag that narrows the deployed session
 * cookie from a shared `.imajin.ai` parent-domain cookie to a host-only
 * cookie. The property that matters most for a p1 change: with the flag
 * unset (or set to anything other than "host"), behavior must be byte-for-
 * byte identical to before this change.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { getSessionCookieOptions } from '../src/session';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getSessionCookieOptions — default behavior is unchanged (#1069 Phase 1)', () => {
  it('sets domain=".imajin.ai" when SESSION_COOKIE_SCOPE is unset (deployed)', () => {
    vi.stubEnv('NEXT_PUBLIC_SERVICE_PREFIX', 'https://');
    vi.stubEnv('SESSION_COOKIE_SCOPE', '');

    const { options } = getSessionCookieOptions('prod');

    expect(options.domain).toBe('.imajin.ai');
  });

  it('sets domain=".imajin.ai" when SESSION_COOKIE_SCOPE is any value other than "host"', () => {
    vi.stubEnv('NEXT_PUBLIC_SERVICE_PREFIX', 'https://');
    vi.stubEnv('SESSION_COOKIE_SCOPE', 'domain');

    const { options } = getSessionCookieOptions('prod');

    expect(options.domain).toBe('.imajin.ai');
  });

  it('never sets domain on localhost regardless of the flag', () => {
    vi.stubEnv('NEXT_PUBLIC_SERVICE_PREFIX', 'http://localhost:3000');
    vi.stubEnv('SESSION_COOKIE_SCOPE', 'host');

    const { options } = getSessionCookieOptions('dev');

    expect(options.domain).toBeUndefined();
  });
});

describe('getSessionCookieOptions — SESSION_COOKIE_SCOPE=host (#1069 Phase 1)', () => {
  it('omits the domain attribute entirely when deployed', () => {
    vi.stubEnv('NEXT_PUBLIC_SERVICE_PREFIX', 'https://');
    vi.stubEnv('SESSION_COOKIE_SCOPE', 'host');

    const { options } = getSessionCookieOptions('prod');

    expect(options.domain).toBeUndefined();
    expect('domain' in options).toBe(false);
  });

  it('leaves every other cookie attribute unchanged', () => {
    vi.stubEnv('NEXT_PUBLIC_SERVICE_PREFIX', 'https://');
    vi.stubEnv('SESSION_COOKIE_SCOPE', 'host');
    const hostScoped = getSessionCookieOptions('prod');

    vi.stubEnv('SESSION_COOKIE_SCOPE', '');
    const domainScoped = getSessionCookieOptions('prod');

    expect(hostScoped.name).toBe(domainScoped.name);
    expect(hostScoped.options.httpOnly).toBe(domainScoped.options.httpOnly);
    expect(hostScoped.options.secure).toBe(domainScoped.options.secure);
    expect(hostScoped.options.sameSite).toBe(domainScoped.options.sameSite);
    expect(hostScoped.options.path).toBe(domainScoped.options.path);
    expect(hostScoped.options.maxAge).toBe(domainScoped.options.maxAge);
  });
});
