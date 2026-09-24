import { describe, it, expect, afterEach } from 'vitest';
import { getServiceBadges, resetServiceBadges, setServiceBadge, subscribeServiceBadges } from '../service-badge-bus';

afterEach(() => {
  resetServiceBadges();
});

describe('service-badge-bus (RFC-19 set_badge, #2275)', () => {
  it('starts with no badges', () => {
    expect(getServiceBadges()).toEqual({});
  });

  it('records a badge count for a service', () => {
    setServiceBadge('market', 3);
    expect(getServiceBadges()).toEqual({ market: 3 });
  });

  it('clamps a negative count to zero', () => {
    setServiceBadge('market', -5);
    expect(getServiceBadges()).toEqual({ market: 0 });
  });

  it('notifies subscribers when a badge changes', () => {
    const seen: Array<Readonly<Record<string, number>>> = [];
    const unsubscribe = subscribeServiceBadges((badges) => seen.push(badges));

    setServiceBadge('coffee', 2);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ coffee: 2 });
    unsubscribe();
  });

  it('does not notify subscribers when the count is unchanged', () => {
    setServiceBadge('coffee', 2);
    const seen: Array<Readonly<Record<string, number>>> = [];
    const unsubscribe = subscribeServiceBadges((badges) => seen.push(badges));

    setServiceBadge('coffee', 2);

    expect(seen).toHaveLength(0);
    unsubscribe();
  });

  it('stops notifying after unsubscribe', () => {
    const seen: Array<Readonly<Record<string, number>>> = [];
    const unsubscribe = subscribeServiceBadges((badges) => seen.push(badges));
    unsubscribe();

    setServiceBadge('learn', 1);

    expect(seen).toHaveLength(0);
  });

  it('tracks multiple services independently', () => {
    setServiceBadge('market', 1);
    setServiceBadge('coffee', 5);
    expect(getServiceBadges()).toEqual({ market: 1, coffee: 5 });
  });
});
