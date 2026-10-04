import { describe, it, expect } from 'vitest';
import { resolveEnabledApps, isAppEnabled, hasConfiguredAppToggles } from '../feature-toggles-compat';

describe('resolveEnabledApps (#2425)', () => {
  it('returns an empty array for null/undefined feature toggles', () => {
    expect(resolveEnabledApps(null)).toEqual([]);
    expect(resolveEnabledApps(undefined)).toEqual([]);
  });

  it('returns an empty array when no app fields are set', () => {
    expect(resolveEnabledApps({ inference_enabled: true })).toEqual([]);
  });

  it('resolves legacy per-app fields (handle-valued) as enabled', () => {
    const apps = resolveEnabledApps({ links: 'ryan', coffee: 'ryan', dykil: null, learn: null });
    expect(apps.sort()).toEqual(['coffee', 'links']);
  });

  it('resolves the modern enabledApps array directly', () => {
    expect(resolveEnabledApps({ enabledApps: ['learn', 'market'] }).sort()).toEqual(['learn', 'market']);
  });

  it('unions legacy fields and enabledApps without duplicates when both are present', () => {
    const apps = resolveEnabledApps({ links: 'ryan', enabledApps: ['links', 'events'] });
    expect(apps.sort()).toEqual(['events', 'links']);
  });

  it('treats an empty-string legacy value as not enabled', () => {
    expect(resolveEnabledApps({ links: '' })).toEqual([]);
  });
});

describe('isAppEnabled (#2425)', () => {
  it('checks a legacy field for a legacy-recognized slug', () => {
    expect(isAppEnabled({ coffee: 'ryan' }, 'coffee')).toBe(true);
    expect(isAppEnabled({ coffee: null }, 'coffee')).toBe(false);
  });

  it('checks enabledApps for a non-legacy slug', () => {
    expect(isAppEnabled({ enabledApps: ['events'] }, 'events')).toBe(true);
    expect(isAppEnabled({ enabledApps: [] }, 'events')).toBe(false);
  });

  it('returns true when either shape enables the slug', () => {
    expect(isAppEnabled({ enabledApps: ['coffee'] }, 'coffee')).toBe(true);
  });

  it('returns false for null feature toggles', () => {
    expect(isAppEnabled(null, 'coffee')).toBe(false);
  });
});

describe('hasConfiguredAppToggles (#2434 — #2425 ruling b)', () => {
  it('is false for null/undefined/empty toggles and for unrelated keys only', () => {
    expect(hasConfiguredAppToggles(null)).toBe(false);
    expect(hasConfiguredAppToggles(undefined)).toBe(false);
    expect(hasConfiguredAppToggles({})).toBe(false);
    expect(hasConfiguredAppToggles({ inference_enabled: true, show_events: true, show_market_items: false })).toBe(false);
  });

  it('is true when enabledApps exists, even if empty', () => {
    expect(hasConfiguredAppToggles({ enabledApps: [] })).toBe(true);
    expect(hasConfiguredAppToggles({ enabledApps: ['learn'] })).toBe(true);
  });

  it('is true when any legacy app field is present, including null (an app switched off)', () => {
    expect(hasConfiguredAppToggles({ coffee: 'ryan' })).toBe(true);
    expect(hasConfiguredAppToggles({ links: null })).toBe(true);
    expect(hasConfiguredAppToggles({ links: '' })).toBe(true);
  });
});
