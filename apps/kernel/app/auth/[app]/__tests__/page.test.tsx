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
  registryAppPublicUrl: vi.fn((app: { slug: string }) => `https://registry-resolved.example/${app.slug}`),
}));

vi.mock('next/navigation', () => ({
  redirect: mocks.redirect,
  notFound: mocks.notFound,
}));

vi.mock('@/src/lib/apps/public-url', () => ({ registryAppPublicUrl: mocks.registryAppPublicUrl }));

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

  it.each(['pay', 'media'])('redirects legacy %s URLs directly to the kernel page', async (app) => {
    await expect(renderPage(app)).rejects.toThrow('NEXT_REDIRECT');
    expect(mocks.redirect).toHaveBeenCalledWith(`/${app}`);
    expect(mocks.getEffectiveDid).not.toHaveBeenCalled();
    expect(mocks.resolveNavAppsForIdentity).not.toHaveBeenCalled();
    expect(screen.queryByTestId('service-embed')).toBeNull();
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

  it('#2425 send-back: resolves the embed baseUrl from the registry row\'s slug via registryAppPublicUrl, not a hardcoded map', async () => {
    mocks.resolveNavAppsForIdentity.mockResolvedValue([
      { slug: 'a-brand-new-app', name: 'Brand New App', icon: '🆕', entryUrl: '/a-brand-new-app', placements: ['auth-submenu'], requiredScope: null, tier: 'third_party' },
    ]);

    render((await AppPage({ params: Promise.resolve({ app: 'a-brand-new-app' }) })) as React.ReactElement);

    expect(mocks.registryAppPublicUrl).toHaveBeenCalledWith(expect.objectContaining({ slug: 'a-brand-new-app', entryUrl: '/a-brand-new-app' }));
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
