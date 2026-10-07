/**
 * Tests for apps/kernel/src/lib/apps/declarations-approval.ts (#2663) — the pure
 * parse/compare helpers behind "the operator approves exactly this list".
 */
import { describe, it, expect } from 'vitest';
import { NO_DECLARATIONS, parseManifestDeclarations, sameDeclarations } from '../declarations-approval';

const MEDIA_READ = { aud: 'jin.imajin.ai', scopes: ['media:read'] };

describe('parseManifestDeclarations', () => {
  it('reads a well-formed snapshot', () => {
    expect(
      parseManifestDeclarations({ providesScopes: ['dykil:read'], dependsOn: [MEDIA_READ], emittableEvents: ['tip.granted'] }),
    ).toEqual({
      providesScopes: ['dykil:read'],
      dependsOn: [MEDIA_READ],
      emittableEvents: ['tip.granted'],
    });
  });

  it('reads a pre-#2638 snapshot (no emittableEvents) as approving no events', () => {
    expect(parseManifestDeclarations({ providesScopes: ['dykil:read'], dependsOn: [] })).toEqual({
      providesScopes: ['dykil:read'],
      dependsOn: [],
      emittableEvents: [],
    });
  });

  it('reads the empty snapshot', () => {
    expect(parseManifestDeclarations({ providesScopes: [], dependsOn: [], emittableEvents: [] })).toEqual(NO_DECLARATIONS);
  });

  it('returns a copy, not the untrusted input', () => {
    const input = {
      providesScopes: ['dykil:read'],
      dependsOn: [{ aud: 'jin.imajin.ai', scopes: ['media:read'] }],
      emittableEvents: ['tip.sent'],
    };
    const parsed = parseManifestDeclarations(input)!;
    parsed.providesScopes.push('dykil:write');
    parsed.dependsOn[0].scopes.push('media:write');
    parsed.emittableEvents.push('tip.granted');

    expect(input.providesScopes).toEqual(['dykil:read']);
    expect(input.dependsOn[0].scopes).toEqual(['media:read']);
    expect(input.emittableEvents).toEqual(['tip.sent']);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'dykil:read'],
    ['an array', []],
    ['missing providesScopes', { dependsOn: [] }],
    ['missing dependsOn', { providesScopes: [] }],
    ['non-array providesScopes', { providesScopes: 'dykil:read', dependsOn: [] }],
    ['a non-string scope', { providesScopes: ['dykil:read', 7], dependsOn: [] }],
    ['non-array dependsOn', { providesScopes: [], dependsOn: 'jin.imajin.ai' }],
    ['a dependency without scopes', { providesScopes: [], dependsOn: [{ aud: 'jin.imajin.ai' }] }],
    ['a dependency without aud', { providesScopes: [], dependsOn: [{ scopes: ['media:read'] }] }],
    ['a null dependency', { providesScopes: [], dependsOn: [null] }],
    ['non-array emittableEvents', { providesScopes: [], dependsOn: [], emittableEvents: 'tip.granted' }],
    ['a non-string emittable event', { providesScopes: [], dependsOn: [], emittableEvents: ['tip.granted', 7] }],
  ])('returns null for %s', (_label, value) => {
    expect(parseManifestDeclarations(value)).toBeNull();
  });
});

describe('sameDeclarations', () => {
  const base = { providesScopes: ['dykil:read', 'dykil:write'], dependsOn: [MEDIA_READ], emittableEvents: ['tip.granted'] };

  it('is true for identical lists', () => {
    expect(sameDeclarations(base, structuredClone(base))).toBe(true);
  });

  it('ignores ordering and duplicates', () => {
    expect(
      sameDeclarations(base, {
        providesScopes: ['dykil:write', 'dykil:read', 'dykil:read'],
        dependsOn: [{ aud: 'jin.imajin.ai', scopes: ['media:read', 'media:read'] }],
        emittableEvents: ['tip.granted', 'tip.granted'],
      }),
    ).toBe(true);
    expect(
      sameDeclarations(
        { providesScopes: [], dependsOn: [MEDIA_READ, { aud: 'a.example.com', scopes: ['events:read'] }], emittableEvents: ['b.x', 'a.x'] },
        { providesScopes: [], dependsOn: [{ aud: 'a.example.com', scopes: ['events:read'] }, MEDIA_READ], emittableEvents: ['a.x', 'b.x'] },
      ),
    ).toBe(true);
  });

  it.each([
    ['an extra providesScope', { ...base, providesScopes: [...base.providesScopes, 'dykil:admin'] }],
    ['a missing providesScope', { ...base, providesScopes: ['dykil:read'] }],
    ['an extra dependency scope', { ...base, dependsOn: [{ aud: 'jin.imajin.ai', scopes: ['media:read', 'media:write'] }] }],
    ['a missing dependency scope', { ...base, dependsOn: [{ aud: 'jin.imajin.ai', scopes: [] }] }],
    ['a different audience', { ...base, dependsOn: [{ aud: 'other.example.com', scopes: ['media:read'] }] }],
    ['an extra dependency', { ...base, dependsOn: [...base.dependsOn, { aud: 'a.example.com', scopes: ['events:read'] }] }],
    ['no dependencies', { ...base, dependsOn: [] }],
    ['an extra emittable event', { ...base, emittableEvents: ['tip.granted', 'listing.purchased'] }],
    ['a missing emittable event', { ...base, emittableEvents: [] }],
    ['a different emittable event', { ...base, emittableEvents: ['tip.sent'] }],
  ])('is false when the actual list has %s', (_label, actual) => {
    expect(sameDeclarations(actual, base)).toBe(false);
  });

  it('compares against the empty list', () => {
    expect(sameDeclarations(NO_DECLARATIONS, { providesScopes: [], dependsOn: [], emittableEvents: [] })).toBe(true);
    expect(sameDeclarations(base, NO_DECLARATIONS)).toBe(false);
  });
});
