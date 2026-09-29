// @vitest-environment jsdom
/**
 * Tests for the dynamic /auth/[app] route (#2425), which replaces the 8
 * static /auth/{events,market,coffee,dykil,learn,links,pay,media}/page.tsx
 * files.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  getEffectiveDid: vi.fn(),
  resolveNavAppsForIdentity: vi.fn(),
  redirect: vi.fn(),
  notFound: vi.fn(),
  buildPublicUrl: vi.fn((slug: string) => `https://registry-resolved.example/${slug}`),
}));

vi.mock('next/navigation', () => ({
  redirect: mocks.redirect,
  notFound: mocks.notFound,
}));

vi.mock('@imajin/config', () => ({ buildPublicUrl: mocks.buildPublicUrl }));

vi.mock('../../lib/get-effective-did', () => ({ getEffectiveDid: mocks.getEffectiveDid }));

vi.mock('@/src/lib/kernel/app-nav', () => ({ resolveNavAppsForIdentity: mocks.resolveNavAppsForIdentity }));

vi.mock('../../components/ServiceEmbed', () => ({
  default: ({ service, did, baseUrl }: { service: string; did: string; baseUrl?: string }) => (
    <div data-testid="service-embed">{`${service}:${did}:${baseUrl ?? ''}`}</div>
  ),
}));

import AppPage from '../page';

const DID = 'did:imajin:abc';

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getEffectiveDid.mockResolvedValue({ effectiveDid: DID });
  mocks.resolveNavAppsForIdentity.mockResolvedValue([]);
  // redirect()/notFound() throw in real Next.js — mirror that so control
  // flow after the call never executes, matching production behavior.
  mocks.redirect.mockImplementation(() => {
    throw new Error('NEXT_REDIRECT');
  });
  mocks.notFound.mockImplementation(() => {
    throw new Error('NEXT_NOT_FOUND');
  });
});

async function renderPage(app: string) {
  const el = await AppPage({ params: Promise.resolve({ app }) });
  render(el as React.ReactElement);
}

describe('AppPage /auth/[app] (#2425)', () => {
  it('redirects to login when there is no effective DID', async () => {
    mocks.getEffectiveDid.mockResolvedValue({ effectiveDid: null });

    await expect(renderPage('coffee')).rejects.toThrow('NEXT_REDIRECT');
    expect(mocks.redirect).toHaveBeenCalledWith('/auth/login');
  });

  it('renders ServiceEmbed directly for a kernel-native service (pay), without a registry lookup', async () => {
    await renderPage('pay');

    // pay is kernel-native — isKernelNativeService short-circuits before
    // the registry list is ever fetched, and no baseUrl override is passed.
    expect(mocks.resolveNavAppsForIdentity).not.toHaveBeenCalled();
    expect(screen.getByTestId('service-embed').textContent).toBe(`pay:${DID}:`);
  });

  it('renders ServiceEmbed directly for the other kernel-native service (media)', async () => {
    await renderPage('media');
    expect(mocks.resolveNavAppsForIdentity).not.toHaveBeenCalled();
  });

  it('renders ServiceEmbed for a registry app enabled on auth-submenu for this identity', async () => {
    mocks.resolveNavAppsForIdentity.mockResolvedValue([
      { slug: 'coffee', name: 'Coffee', icon: '☕', entryUrl: '/coffee', placements: ['auth-submenu'], requiredScope: null, tier: 'first_party' },
    ]);

    render((await AppPage({ params: Promise.resolve({ app: 'coffee' }) })) as React.ReactElement);

    expect(screen.getByTestId('service-embed').textContent).toBe(
      `coffee:${DID}:https://registry-resolved.example/coffee`,
    );
    expect(mocks.notFound).not.toHaveBeenCalled();
  });

  it('#2425 send-back: resolves the embed baseUrl from the registry row\'s slug via buildPublicUrl, not a hardcoded map', async () => {
    mocks.resolveNavAppsForIdentity.mockResolvedValue([
      { slug: 'a-brand-new-app', name: 'Brand New App', icon: '🆕', entryUrl: '/a-brand-new-app', placements: ['auth-submenu'], requiredScope: null, tier: 'third_party' },
    ]);

    render((await AppPage({ params: Promise.resolve({ app: 'a-brand-new-app' }) })) as React.ReactElement);

    expect(mocks.buildPublicUrl).toHaveBeenCalledWith('a-brand-new-app');
    expect(screen.getByTestId('service-embed').textContent).toBe(
      `a-brand-new-app:${DID}:https://registry-resolved.example/a-brand-new-app`,
    );
  });

  it('404s for an unknown slug', async () => {
    mocks.resolveNavAppsForIdentity.mockResolvedValue([]);

    await expect(renderPage('not-a-real-app')).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mocks.notFound).toHaveBeenCalled();
  });

  it('404s for a known registry app that is not enabled for this identity (disabled)', async () => {
    // coffee exists in the registry generally, but resolveNavAppsForIdentity
    // already returns only what's enabled ∩ scoped for this identity — an
    // empty/absent result means "not enabled", same 404 as unknown.
    mocks.resolveNavAppsForIdentity.mockResolvedValue([
      { slug: 'learn', name: 'Learn', icon: '📚', entryUrl: '/learn', placements: ['auth-submenu'], requiredScope: null, tier: 'first_party' },
    ]);

    await expect(renderPage('coffee')).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('404s for a registry app enabled but not on the auth-submenu placement', async () => {
    mocks.resolveNavAppsForIdentity.mockResolvedValue([
      { slug: 'coffee', name: 'Coffee', icon: '☕', entryUrl: '/coffee', placements: ['launcher'], requiredScope: null, tier: 'first_party' },
    ]);

    await expect(renderPage('coffee')).rejects.toThrow('NEXT_NOT_FOUND');
  });
});
