// @vitest-environment jsdom
/**
 * Money tab wiring (#2211): the tab is gated on scope alone (like
 * Security's 'actor' gate), not on `enabledServices` — it's the
 * business-DID receivable surface, not a toggleable vertical service.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { resetServiceBadges, setServiceBadge } from '../../lib/service-badge-bus';

vi.mock('next/navigation', () => ({
  usePathname: () => '/auth',
}));

const { default: IdentityTabBar } = await import('../IdentityTabBar');

afterEach(() => {
  cleanup();
  resetServiceBadges();
});

describe('IdentityTabBar — Money tab', () => {
  it('renders the Money tab when showMoney is true', () => {
    render(
      <IdentityTabBar showSettings={false} showMembers={false} showSecurity={false} showMoney enabledServices={[]} />,
    );
    expect(screen.getByText('Money')).toBeDefined();
  });

  it('hides the Money tab when showMoney is false (e.g. a personal/actor identity)', () => {
    render(
      <IdentityTabBar
        showSettings={false}
        showMembers={false}
        showSecurity={false}
        showMoney={false}
        enabledServices={[]}
      />,
    );
    expect(screen.queryByText('Money')).toBeNull();
  });

  it('does not gate Money on enabledServices — unlike the toggleable Pay service tab', () => {
    render(
      <IdentityTabBar
        showSettings={false}
        showMembers={false}
        showSecurity={false}
        showMoney
        enabledServices={[]}
      />,
    );
    expect(screen.getByText('Money')).toBeDefined();
    expect(screen.queryByText('Pay')).toBeNull();
  });
});

describe('IdentityTabBar — set_badge display (RFC-19, #2275)', () => {
  it('shows a badge count on a service tab once set_badge fires for it', () => {
    setServiceBadge('coffee', 3);

    render(
      <IdentityTabBar
        showSettings={false}
        showMembers={false}
        showSecurity={false}
        showMoney={false}
        enabledServices={['coffee', 'market']}
      />,
    );

    expect(screen.getByText('3')).toBeDefined();
  });

  it('shows no badge for a service with a zero or unset count', () => {
    setServiceBadge('coffee', 0);

    render(
      <IdentityTabBar
        showSettings={false}
        showMembers={false}
        showSecurity={false}
        showMoney={false}
        enabledServices={['coffee', 'market']}
      />,
    );

    expect(screen.queryByText('0')).toBeNull();
  });

  it('caps a large badge count at 99+', () => {
    setServiceBadge('market', 150);

    render(
      <IdentityTabBar
        showSettings={false}
        showMembers={false}
        showSecurity={false}
        showMoney={false}
        enabledServices={['market']}
      />,
    );

    expect(screen.getByText('99+')).toBeDefined();
  });
});
