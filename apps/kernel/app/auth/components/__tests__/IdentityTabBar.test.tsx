// @vitest-environment jsdom
/**
 * Money tab wiring (#2211): the tab is gated on scope alone (like
 * Security's 'actor' gate), not on the registry `apps` prop — it's the
 * business-DID receivable surface, not a toggleable vertical service.
 *
 * Tax tab wiring (#2420): shares the same business-scope gate as Money,
 * via its own `showTax` prop.
 *
 * Service-tab rendering (#2425): SERVICE_TABS's hard-coded literal array is
 * gone — tabs for the six extractable apps (coffee/dykil/links/learn/
 * events/market) now come from the `apps` prop (resolved server-side from
 * `registry.apps` by `resolveNavAppsForIdentity`). Wallet and Media live
 * in kernel navigation, not identity-management tabs.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { resetServiceBadges, setServiceBadge } from '../../lib/service-badge-bus';
import type { NavApp } from '@/src/lib/kernel/app-nav';

vi.mock('next/navigation', () => ({
  usePathname: () => '/auth',
}));

const { default: IdentityTabBar } = await import('../IdentityTabBar');

function navApp(overrides: Partial<NavApp>): NavApp {
  return {
    slug: 'coffee',
    name: 'Coffee',
    icon: '☕',
    entryUrl: '/coffee',
    placements: ['auth-submenu'],
    requiredScope: null,
    tier: 'first_party',
    ...overrides,
  };
}

const BASE_PROPS = {
  showSettings: false,
  showMembers: false,
  showSecurity: false,
  showMoney: false,
  showTax: false,
  apps: [] as NavApp[],
};

afterEach(() => {
  cleanup();
  resetServiceBadges();
});

describe('IdentityTabBar — Money tab', () => {
  it('renders the Money tab when showMoney is true', () => {
    render(<IdentityTabBar {...BASE_PROPS} showMoney />);
    expect(screen.getByText('Money')).toBeDefined();
  });

  it('hides the Money tab when showMoney is false (e.g. a personal/actor identity)', () => {
    render(<IdentityTabBar {...BASE_PROPS} showMoney={false} />);
    expect(screen.queryByText('Money')).toBeNull();
  });

  it('does not gate Money on the apps prop', () => {
    render(<IdentityTabBar {...BASE_PROPS} showMoney />);
    expect(screen.getByText('Money')).toBeDefined();
    expect(screen.queryByText('Pay')).toBeNull();
  });
});

describe('IdentityTabBar — Tax registrations tab (#2420)', () => {
  it.each([true, false])('offers legal-entity settings for business or human identities (%s)', showTax => {
    render(<IdentityTabBar {...BASE_PROPS} showTax={showTax} />);
    expect(screen.getByRole('link', { name: 'Legal entity' }).getAttribute('href')).toBe('/auth/legal-entity');
  });
  it('renders the Tax tab when showTax is true', () => {
    render(<IdentityTabBar {...BASE_PROPS} showTax />);
    expect(screen.getByText('Tax')).toBeDefined();
  });

  it('hides the Tax tab when showTax is false (e.g. a personal/actor identity)', () => {
    render(<IdentityTabBar {...BASE_PROPS} showTax={false} />);
    expect(screen.queryByText('Tax')).toBeNull();
  });
});

describe('IdentityTabBar — registry-driven service tabs (#2425)', () => {
  it('renders a tab for each app in the apps prop, linked to /auth/<slug>', () => {
    render(
      <IdentityTabBar
        {...BASE_PROPS}
        apps={[navApp({ slug: 'coffee', name: 'Coffee' }), navApp({ slug: 'learn', name: 'Learn' })]}
      />,
    );

    const coffeeLink = screen.getByText('Coffee').closest('a');
    const learnLink = screen.getByText('Learn').closest('a');
    expect(coffeeLink?.getAttribute('href')).toBe('/auth/coffee');
    expect(learnLink?.getAttribute('href')).toBe('/auth/learn');
  });

  it('renders no service tabs when apps is empty', () => {
    render(<IdentityTabBar {...BASE_PROPS} />);
    expect(screen.queryByText('Coffee')).toBeNull();
    expect(screen.queryByText('Pay')).toBeNull();
    expect(screen.queryByText('Media')).toBeNull();
    expect(screen.getByRole('link', { name: 'Add app' }).getAttribute('href')).toBe('/auth/app-directory');
  });


});

describe('IdentityTabBar — set_badge display (RFC-19, #2275)', () => {
  it('shows a badge count on a service tab once set_badge fires for it', () => {
    setServiceBadge('coffee', 3);

    render(<IdentityTabBar {...BASE_PROPS} apps={[navApp({ slug: 'coffee' }), navApp({ slug: 'market', name: 'Market' })]} />);

    expect(screen.getByText('3')).toBeDefined();
  });

  it('shows no badge for a service with a zero or unset count', () => {
    setServiceBadge('coffee', 0);

    render(<IdentityTabBar {...BASE_PROPS} apps={[navApp({ slug: 'coffee' }), navApp({ slug: 'market', name: 'Market' })]} />);

    expect(screen.queryByText('0')).toBeNull();
  });

  it('caps a large badge count at 99+', () => {
    setServiceBadge('market', 150);

    render(<IdentityTabBar {...BASE_PROPS} apps={[navApp({ slug: 'market', name: 'Market' })]} />);

    expect(screen.getByText('99+')).toBeDefined();
  });
});
