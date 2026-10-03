// @vitest-environment jsdom
/**
 * LandingGrid (#2434) — tiles come from `/registry/api/launcher` (registry
 * apps + static kernel/project tiles), narrowed per signed-in identity.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';

vi.mock('@imajin/config', () => ({ buildPublicUrl: (slug: string) => `https://node.test/${slug}` }));

import { LandingGrid } from '../LandingGrid';

interface Tile {
  name: string;
  label: string;
  category: string;
  visibility: string;
  source: 'static' | 'registry';
}

const tile = (name: string, overrides: Partial<Tile> = {}): Tile & Record<string, string> => ({
  name,
  label: name,
  description: name,
  icon: 'x',
  url: `https://node.test/${name}`,
  category: 'core',
  visibility: 'public',
  source: 'registry',
  ...overrides,
});

const LAUNCHER_TILES = [
  tile('pay', { label: 'Wallet', category: 'kernel', source: 'static' }),
  tile('registry-only-app', { label: 'Registry Only' }),
  tile('coffee', { label: 'Coffee', category: 'creator' }),
];

function stubFetch(options: { tier?: string; identityApps?: string[] | 'fail' }) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/api/launcher')) return Response.json({ services: LAUNCHER_TILES });
    if (url.endsWith('/api/session')) {
      return options.tier ? Response.json({ tier: options.tier }) : new Response(null, { status: 401 });
    }
    if (url.includes('/api/apps?placement=launcher')) {
      if (options.identityApps === 'fail' || !options.identityApps) return new Response(null, { status: 500 });
      return Response.json({ apps: options.identityApps.map((slug) => ({ slug })) });
    }
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('LandingGrid (#2434)', () => {
  it('lists a registry-only app from the launcher endpoint, not services.ts', async () => {
    const calls = stubFetch({});

    render(<LandingGrid />);

    expect(await screen.findByText('Registry Only')).toBeTruthy();
    expect(screen.getByText('Wallet')).toBeTruthy();
    expect(calls).toContain('https://node.test/registry/api/launcher');
    expect(calls.some((url) => url.endsWith('/api/specs'))).toBe(false);
    // Anonymous visitors never trigger the identity-scoped lookup.
    expect(calls.some((url) => url.includes('/api/apps'))).toBe(false);
  });

  it('narrows registry tiles to the apps the signed-in identity may see, keeping static tiles', async () => {
    stubFetch({ tier: 'established', identityApps: ['registry-only-app'] });

    render(<LandingGrid />);

    expect(await screen.findByText('Registry Only')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('Coffee')).toBeNull());
    expect(screen.getByText('Wallet')).toBeTruthy();
  });

  it('shows the full public list when the identity lookup fails', async () => {
    stubFetch({ tier: 'established', identityApps: 'fail' });

    render(<LandingGrid />);

    expect(await screen.findByText('Coffee')).toBeTruthy();
    expect(screen.getByText('Registry Only')).toBeTruthy();
  });
});
