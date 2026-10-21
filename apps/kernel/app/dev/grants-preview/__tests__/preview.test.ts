import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGrantsFixtureTransport } from '../fixture-transport';
import GrantsPreviewPage from '../page';

vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('NEXT_NOT_FOUND'); } }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('grants development fixture preview', () => {
  it.each(['production', 'test'])('refuses the route and transport in %s', environment => {
    vi.stubEnv('NODE_ENV', environment);
    expect(() => GrantsPreviewPage()).toThrow('NEXT_NOT_FOUND');
    expect(() => createGrantsFixtureTransport()).toThrow('development-only');
  });

  it('allows the route in development and keeps all fixture requests in memory', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const network = vi.fn();
    vi.stubGlobal('fetch', network);
    expect(GrantsPreviewPage()).toBeDefined();
    const transport = createGrantsFixtureTransport();
    const initial = await (await transport('/jin/api/grants')).json();
    expect(initial.grants[0].surplusGrantIds).toHaveLength(9);
    for (const attestationId of initial.grants[0].surplusGrantIds) {
      expect((await transport('/api/auth/revoke', { method: 'POST', body: JSON.stringify({ attestationId }) })).ok).toBe(true);
    }
    const refreshed = await (await transport('/jin/api/grants')).json();
    expect(refreshed.grants[0].id).toBe('app-authorization:fixture-karaoke-9');
    expect(refreshed.grants[0].surplusGrantIds).toEqual([]);
    expect(refreshed.grants.filter((card: { status: string }) => card.status === 'revoked')).toHaveLength(10);
    expect(network).not.toHaveBeenCalled();
    expect((await transport('/api/auth/revoke', {
      method: 'POST', body: JSON.stringify({ attestationId: 'fixture-karaoke-0' }),
    })).status).toBe(409);
    expect((await transport('/api/auth/revoke', {
      method: 'POST', body: JSON.stringify({ attestationId: 'real-grant' }),
    })).status).toBe(404);
    await expect(transport('/api/auth/consent', { method: 'POST' })).rejects.toThrow('no network request');
  });

  it('rechecks the environment before each transport request', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const transport = createGrantsFixtureTransport();
    vi.stubEnv('NODE_ENV', 'production');
    await expect(transport('/jin/api/grants')).rejects.toThrow('development-only');
  });
});
