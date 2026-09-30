// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ServiceLinks } from '../ServiceLinks';
import type { ProfileData } from '../../lib/types';
import type { NavApp } from '@/src/lib/kernel/app-nav';

vi.mock('@imajin/config', () => ({ buildPublicUrl: (slug: string) => `/${slug}` }));
vi.mock('../AskButton', () => ({ AskButton: () => <div data-testid="ask-button" /> }));

afterEach(() => {
  cleanup();
});

function makeProfile(overrides: Partial<ProfileData> = {}): ProfileData {
  return {
    did: 'did:imajin:abc',
    handle: 'ryan',
    displayName: 'Ryan',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function navApp(overrides: Partial<NavApp>): NavApp {
  return {
    slug: 'coffee',
    name: 'Coffee',
    icon: '☕',
    entryUrl: '/coffee',
    placements: ['launcher', 'home', 'auth-submenu'],
    requiredScope: null,
    tier: 'first_party',
    ...overrides,
  };
}

describe('ServiceLinks (#2425 — registry apps ∩ resolveEnabledApps, no literal app names)', () => {
  it('shows no service buttons when apps is empty', () => {
    render(<ServiceLinks profile={makeProfile()} viewerDid={null} apps={[]} />);
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('renders a button per app, using the registry-provided icon/name, linked to /<slug>/<handle>', () => {
    render(
      <ServiceLinks
        profile={makeProfile()}
        viewerDid={null}
        apps={[navApp({ slug: 'links', name: 'Links', icon: '🔗' })]}
      />,
    );

    const link = screen.getByText('🔗 Links').closest('a');
    expect(link?.getAttribute('href')).toBe('/links/ryan');
  });

  it('renders multiple apps generically, in the order the apps prop provides', () => {
    render(
      <ServiceLinks
        profile={makeProfile()}
        viewerDid={null}
        apps={[navApp({ slug: 'links', name: 'Links', icon: '🔗' }), navApp({ slug: 'coffee', name: 'Coffee', icon: '☕' })]}
      />,
    );

    expect(screen.getByText('🔗 Links')).toBeDefined();
    expect(screen.getByText('☕ Coffee')).toBeDefined();
  });

  it('renders an app for any registry slug, not just the historically hard-coded links/coffee pair', () => {
    render(
      <ServiceLinks
        profile={makeProfile()}
        viewerDid={null}
        apps={[navApp({ slug: 'a-brand-new-app', name: 'Brand New App', icon: '🆕' })]}
      />,
    );

    const link = screen.getByText('🆕 Brand New App').closest('a');
    expect(link?.getAttribute('href')).toBe('/a-brand-new-app/ryan');
  });
});
