/**
 * Tests for the profile edit form's merge-not-replace toggle save (#2434).
 */
import { describe, it, expect } from 'vitest';
import { mergeFeatureToggles, type FeatureTogglesFormState } from '../feature-toggles-merge';
import { resolveEnabledApps } from '../feature-toggles-compat';

function form(overrides: Partial<FeatureTogglesFormState> = {}): FeatureTogglesFormState {
  return {
    serviceToggles: { links: false, coffee: false, dykil: false, learn: false, inference: false },
    showMarketItems: false,
    showEvents: false,
    handle: 'ryan',
    ...overrides,
  };
}

describe('mergeFeatureToggles (#2434)', () => {
  it('preserves enabledApps when the form does not touch those slugs', () => {
    const merged = mergeFeatureToggles(
      { enabledApps: ['events', 'market', 'some-new-app'] },
      form({ serviceToggles: { links: true, coffee: false, dykil: false, learn: false, inference: false } }),
    );

    expect(merged.enabledApps).toEqual(['events', 'market', 'some-new-app']);
    expect(merged.links).toBe('ryan');
  });

  it('preserves unrelated/unknown keys instead of rebuilding from scratch', () => {
    const existing = { inference_enabled: true, futureKey: { nested: 1 }, enabledApps: ['events'] };

    const merged = mergeFeatureToggles(existing, form());

    expect(merged).toMatchObject({ futureKey: { nested: 1 }, enabledApps: ['events'] });
  });

  it('overlays the keys the form controls', () => {
    const merged = mergeFeatureToggles(
      { inference_enabled: false, show_events: false, show_market_items: false, coffee: null },
      form({
        serviceToggles: { links: false, coffee: true, dykil: false, learn: false, inference: true },
        showEvents: true,
        showMarketItems: true,
      }),
    );

    expect(merged).toMatchObject({
      inference_enabled: true,
      show_events: true,
      show_market_items: true,
      coffee: 'ryan',
      links: null,
      dykil: null,
      learn: null,
    });
  });

  it('writes null for an enabled app when the profile has no handle (existing behavior)', () => {
    const merged = mergeFeatureToggles({}, form({ handle: undefined, serviceToggles: { links: true } }));

    expect(merged.links).toBeNull();
  });

  it('does not invent enabledApps when the profile never had one', () => {
    const merged = mergeFeatureToggles({ links: 'ryan' }, form());

    expect('enabledApps' in merged).toBe(false);
  });

  it('tolerates null/undefined existing toggles', () => {
    expect(mergeFeatureToggles(undefined, form()).inference_enabled).toBe(false);
    expect(mergeFeatureToggles(null, form({ showEvents: true })).show_events).toBe(true);
  });

  it('drops a form-controlled slug from enabledApps when the user switches it off, so the toggle takes effect', () => {
    const merged = mergeFeatureToggles(
      { enabledApps: ['coffee', 'events'], coffee: 'ryan' },
      form({ serviceToggles: { links: false, coffee: false, dykil: false, learn: false, inference: false } }),
    );

    expect(merged.enabledApps).toEqual(['events']);
    expect(resolveEnabledApps(merged)).toEqual(['events']);
  });

  it('keeps a form-controlled slug in enabledApps when the user leaves it on', () => {
    const merged = mergeFeatureToggles(
      { enabledApps: ['coffee', 'events'] },
      form({ serviceToggles: { links: false, coffee: true, dykil: false, learn: false, inference: false } }),
    );

    expect(merged.enabledApps).toEqual(['coffee', 'events']);
  });

  it('does not mutate the loaded toggles', () => {
    const existing = Object.freeze({ enabledApps: Object.freeze(['coffee', 'events']) as unknown as string[] });

    expect(() => mergeFeatureToggles(existing, form())).not.toThrow();
    expect(existing.enabledApps).toEqual(['coffee', 'events']);
  });
});
