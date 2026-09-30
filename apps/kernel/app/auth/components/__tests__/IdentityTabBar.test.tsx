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
 * `registry.apps` by `resolveNavAppsForIdentity`); Pay/Media stay a small
 * kernel-native pair gated by `showPay`/`showMedia`.
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
  showPay: false,
  showMedia: false,
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

  it('does not gate Money on the apps/showPay props — unlike the toggleable Pay service tab', () => {
    render(<IdentityTabBar {...BASE_PROPS} showMoney showPay={false} />);
    expect(screen.getByText('Money')).toBeDefined();
    expect(screen.queryByText('Pay')).toBeNull();
  });
});

describe('IdentityTabBar — Tax registrations tab (#2420)', () => {
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

  it('renders no service tabs when apps is empty and showPay/showMedia are false', () => {
    render(<IdentityTabBar {...BASE_PROPS} />);
    expect(screen.queryByText('Coffee')).toBeNull();
    expect(screen.queryByText('Pay')).toBeNull();
    expect(screen.queryByText('Media')).toBeNull();
  });

  it('renders the Pay/Media kernel-native tabs independently of the apps prop', () => {
    render(<IdentityTabBar {...BASE_PROPS} apps={[]} showPay showMedia />);
    expect(screen.getByText('Pay')).toBeDefined();
    expect(screen.getByText('Media')).toBeDefined();
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
