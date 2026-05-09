import { describe, it, expect } from 'vitest';
import { requiredTier, hasTier } from '../src/permissions';
import type { Action, Tier } from '../src/permissions';

describe('requiredTier', () => {
  it('soft actions: buy_ticket, view_tickets, event_lobby_chat', () => {
    expect(requiredTier('buy_ticket')).toBe('soft');
    expect(requiredTier('view_tickets')).toBe('soft');
    expect(requiredTier('event_lobby_chat')).toBe('soft');
  });

  it('preliminary actions: edit_profile', () => {
    expect(requiredTier('edit_profile')).toBe('preliminary');
  });

  it('established actions: create_event, send_invite', () => {
    expect(requiredTier('create_event')).toBe('established');
    expect(requiredTier('send_invite')).toBe('established');
  });

  it('established+graph actions: dm, pod_chat, create_pod, connections', () => {
    expect(requiredTier('dm')).toBe('established+graph');
    expect(requiredTier('pod_chat')).toBe('established+graph');
    expect(requiredTier('create_pod')).toBe('established+graph');
    expect(requiredTier('connections')).toBe('established+graph');
  });
});

describe('hasTier', () => {
  it('none has no tier', () => {
    expect(hasTier('none', 'soft')).toBe(false);
    expect(hasTier('none', 'none')).toBe(true);
  });

  it('soft meets soft but not higher', () => {
    expect(hasTier('soft', 'soft')).toBe(true);
    expect(hasTier('soft', 'preliminary')).toBe(false);
  });

  it('established meets established and below', () => {
    expect(hasTier('established', 'soft')).toBe(true);
    expect(hasTier('established', 'preliminary')).toBe(true);
    expect(hasTier('established', 'established')).toBe(true);
    expect(hasTier('established', 'steward')).toBe(false);
  });

  it('operator meets everything', () => {
    const tiers: Tier[] = ['none', 'soft', 'preliminary', 'established', 'established+graph', 'steward', 'operator'];
    for (const tier of tiers) {
      expect(hasTier('operator', tier)).toBe(true);
    }
  });

  it('established meets established+graph (tier-only check)', () => {
    expect(hasTier('established', 'established+graph')).toBe(true);
  });
});
