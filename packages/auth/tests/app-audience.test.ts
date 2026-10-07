/**
 * Tests for the app-token audience resolver (#2706): the audience an app
 * verifies against is `IMAJIN_APP_AUD`, defaulting to its registry slug —
 * never a host.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { resolveAppAudience, isAppAudienceSlug, APP_AUD_ENV } from '../src/app-audience';

afterEach(() => {
  delete process.env[APP_AUD_ENV];
});

describe('resolveAppAudience', () => {
  it('defaults to the registry slug when IMAJIN_APP_AUD is unset', () => {
    expect(resolveAppAudience('dykil')).toBe('dykil');
  });

  it('prefers IMAJIN_APP_AUD when set', () => {
    process.env[APP_AUD_ENV] = 'dykil-staging';
    expect(resolveAppAudience('dykil')).toBe('dykil-staging');
  });

  it('treats a blank IMAJIN_APP_AUD as unset', () => {
    process.env[APP_AUD_ENV] = '   ';
    expect(resolveAppAudience('links')).toBe('links');
  });

  it('works from IMAJIN_APP_AUD alone', () => {
    process.env[APP_AUD_ENV] = 'coffee';
    expect(resolveAppAudience()).toBe('coffee');
  });

  it('throws when neither the env var nor a slug is available', () => {
    expect(() => resolveAppAudience()).toThrow(/No app audience configured/);
  });

  it.each(['dev-jin.imajin.ai', 'jin.imajin.ai', 'https://jin.imajin.ai/dykil', 'jin.imajin.ai:443', 'Dykil'])(
    'rejects a host-shaped slug %s',
    (host) => {
      expect(() => resolveAppAudience(host)).toThrow(/never hosts or URLs/);
    },
  );

  it('rejects a host-shaped IMAJIN_APP_AUD and names the env var', () => {
    process.env[APP_AUD_ENV] = 'dev-jin.imajin.ai';
    expect(() => resolveAppAudience('dykil')).toThrow(/from IMAJIN_APP_AUD/);
  });
});

describe('isAppAudienceSlug', () => {
  it.each(['dykil', 'links', 'jin', 'my-app', 'my_app', 'app2'])('accepts %s', (v) => {
    expect(isAppAudienceSlug(v)).toBe(true);
  });

  it.each(['', 'a.b', 'a/b', '-a', 'a-', 'a--b', 'A', 'a b'])('rejects %j', (v) => {
    expect(isAppAudienceSlug(v)).toBe(false);
  });
});
