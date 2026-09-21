// @vitest-environment jsdom
/**
 * Money tab wiring (#2211): the tab is gated on scope alone (like
 * Security's 'actor' gate), not on `enabledServices` — it's the
 * business-DID receivable surface, not a toggleable vertical service.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  usePathname: () => '/auth',
}));

const { default: IdentityTabBar } = await import('../IdentityTabBar');

afterEach(() => {
  cleanup();
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
